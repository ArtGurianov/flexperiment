#!/usr/bin/env python3
"""Canary-only operator alerts. Fixed payloads; no runtime/DB/log access or retries.

One incident per event: the first failure alerts, identical repeats are
suppressed until a reminder is due, and the unit's OnSuccess hook
(--recovered) sends one recovery and closes it. Suppression never hides the
failed systemd unit itself.
"""
import datetime
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.request
import uuid

CONFIG = Path('/root/flexperiment-v2-owner/canary-alerts.json')
EVENTS = {'commerce-backup', 'commerce-freshness', 'platform-backup', 'platform-freshness', 'probe'}
URLS = {'notisend': 'https://api.notisend.ru/v1/email/messages',
        'telebuzzy': 'https://telebuzzy.xyz/api/notify'}
MAX_BYTES = 16384
STATE = Path('/var/lib/flexperiment-v2-canary-alerts')
REMINDER_SECONDS = 6 * 3600
TITLES = {'probe': '[CANARY] Flexperiment backup alert TEST', 'opened': '[CANARY] Flexperiment backup alert',
          'reminder': '[CANARY] Flexperiment backup still failing', 'recovered': '[CANARY] Flexperiment backup recovered'}


def require(condition):
    if not condition:
        raise ValueError('ALERT_CONFIGURATION_INVALID')


def load_config(path=CONFIG):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= MAX_BYTES)
    data = json.loads(path.read_text())
    require(set(data) == {'notisendKey', 'telebuzzyKey', 'fromEmail', 'fromName', 'replyTo'})
    for value in data.values():
        require(isinstance(value, str) and 0 < len(value) <= 512
                and not re.search(r'[\x00-\x1f\x7f]', value))
    for key in ['fromEmail', 'replyTo']:
        require(re.fullmatch(r'[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+', data[key]))
    return data


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(channel, config, body, event_id):
    key = config['notisendKey' if channel == 'notisend' else 'telebuzzyKey']
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json',
               'Authorization': 'Bearer ' + key}
    if channel == 'telebuzzy':
        headers['Idempotency-Key'] = event_id
    req = urllib.request.Request(URLS[channel], data=json.dumps(body).encode(),
                                 headers=headers, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=10) as response:
            status = response.status
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return {'result': 'UNKNOWN', 'httpStatus': status}
        if channel == 'telebuzzy':
            # Provider acceptance is NOT independently verified Telegram delivery.
            return {'result': 'ACCEPTED', 'httpStatus': status}
        data = json.loads(raw)
        if not isinstance(data, dict) or 'errors' in data:
            return {'result': 'REFUSED', 'httpStatus': status}
        message_id = data.get('id')
        valid_id = ((type(message_id) is int and message_id > 0)
                    or (isinstance(message_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', message_id)))
        if isinstance(message_id, str) and any(value in message_id for value in [config['notisendKey'], config['telebuzzyKey']]):
            valid_id = False
        if not valid_id or data.get('status') not in ['queued', 'sent', 'delivered']:
            return {'result': 'UNKNOWN', 'httpStatus': status}
        return {'result': 'DELIVERED' if data['status'] == 'delivered' else 'ACCEPTED',
                'httpStatus': status, 'messageId': message_id, 'providerStatus': data['status']}
    except urllib.error.HTTPError as error:
        error.close()
        return {'result': 'REFUSED', 'httpStatus': error.code}
    except Exception:
        # Never print exceptions or provider bodies: either can reflect credentials.
        return {'result': 'UNKNOWN'}


def notify(event, config, send=request, kind=None, history=''):
    require(event in EVENTS)
    kind = kind or ('probe' if event == 'probe' else 'opened')
    event_id = str(uuid.uuid4())
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    title = TITLES[kind]
    message = f'{title}\nEvent: {event}\nTime: {timestamp}\nReference: {event_id}\n{history}Check canary backup/freshness service status. No customer or database data included.'
    bodies = {
        'notisend': {'to': 'accidents@flexperiment.ru', 'from_email': config['fromEmail'],
                     'from_name': config['fromName'], 'subject': title, 'text': message,
                     'smtp_headers': {'Reply-To': config['replyTo']}},
        'telebuzzy': {'title': title, 'severity': 'info' if kind in ['probe', 'recovered'] else 'critical',
                     'app': 'flexperiment-v2-canary-backups', 'action': 'Check canary backups',
                     'event': event, 'reference': event_id, 'timestamp': timestamp},
    }
    outcomes = {}
    for channel in ['notisend', 'telebuzzy']:
        try:
            outcomes[channel] = send(channel, config, bodies[channel], event_id)
        except Exception:
            outcomes[channel] = {'result': 'UNKNOWN'}
    return {'event': event, 'kind': kind, 'reference': event_id, 'timestamp': timestamp, 'channels': outcomes}


def accepted(result):
    return any(v['result'] in ['ACCEPTED', 'DELIVERED'] for v in result['channels'].values())


def read_state(path):
    """Open incident or None. Anything unexpected fails toward notifying."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    with os.fdopen(descriptor) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > 1024:
            return None
        try:
            state = json.loads(handle.read())
        except ValueError:
            return None
    fields = {'openedAt', 'lastSentAt', 'suppressed'}
    if not isinstance(state, dict) or set(state) != fields or not all(type(state[k]) is int and state[k] >= 0 for k in fields):
        return None
    return state


def write_state(path, state):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(json.dumps(state)); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, path)


def history(state, now=None):
    since = datetime.datetime.fromtimestamp(state['openedAt'], datetime.timezone.utc).isoformat()
    until = '' if now is None else ', recovered ' + datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()
    return f'Failing since: {since}{until} ({state["suppressed"]} repeated failures not re-sent)\n'


def handle(event, config, send=None, state_dir=None, now=None, recovered=False):
    require(event in EVENTS and not (recovered and event == 'probe'))
    send = send or request
    if event == 'probe':
        return notify(event, config, send)
    path = (state_dir or STATE) / (event + '.json')
    state = read_state(path)
    at = int((now or time.time)())
    if recovered:
        if state is None:
            return {'event': event, 'result': 'NO_OPEN_INCIDENT'}
        result = notify(event, config, send, 'recovered', history(state, at))
        if accepted(result):
            path.unlink(missing_ok=True)
        return result
    if state is not None and at - state['lastSentAt'] < REMINDER_SECONDS:
        write_state(path, {**state, 'suppressed': state['suppressed'] + 1})
        return {'event': event, 'result': 'SUPPRESSED', 'suppressed': state['suppressed'] + 1}
    result = notify(event, config, send, 'reminder' if state else 'opened', history(state) if state else '')
    # An unaccepted notification is not recorded, so the next failure tries again.
    if accepted(result):
        write_state(path, {'openedAt': state['openedAt'] if state else at, 'lastSentAt': at, 'suppressed': 0})
    return result


def main():
    args = sys.argv[1:]
    recovered = len(args) == 2 and args[0] == '--recovered'
    require(os.geteuid() == 0 and (len(args) == 1 or recovered) and args[-1] in EVENTS
            and not (recovered and args[-1] == 'probe'))
    result = handle(args[-1], load_config(), recovered=recovered)
    print(json.dumps(result, separators=(',', ':')))
    if 'channels' not in result:
        return 0
    return 0 if all(v['result'] in ['ACCEPTED', 'DELIVERED'] for v in result['channels'].values()) else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"result":"ALERT_CONFIGURATION_OR_EXECUTION_HOLD"}')
        sys.exit(1)
