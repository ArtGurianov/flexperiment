#!/usr/bin/env python3
"""Canary-only operator alerts. Fixed payloads; no application/DB/log access.

One incident per event, tracked per channel: a channel gets the first
failure, then nothing until a reminder is due; the unit's OnSuccess hook
(--recovered) sends one recovery to every channel that acknowledged the
incident. A channel that did not acknowledge is retried on the next run.
Alert and recovery for one event are serialized by a lock held across the
read, the provider calls and the state write. Suppression never hides the
failed systemd unit itself.
Only allowlisted source-unit metadata and the host boot ID are read to reject
obsolete callbacks; provider calls have no automatic retries within a run.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import subprocess
import time
import urllib.error
import urllib.request
import uuid

CONFIG = Path('/root/flexperiment-v2-owner/canary-alerts.json')
EVENTS = {'commerce-backup', 'commerce-freshness', 'platform-backup', 'platform-freshness', 'probe'}
CHANNELS = ('notisend', 'telebuzzy')
# Template instances identify the exact originating unit, including the two
# distinct Commerce installations. Only these systemd metadata reads are allowed.
SOURCE_BINDINGS = {
    'commerce-backup': ('commerce-backup', 'flexperiment-commerce-v2-backup@canary.service'),
    'commerce-freshness': ('commerce-freshness', 'commerce-canary-backup-freshness.service'),
    'platform-backup': ('platform-backup', 'platform-canary-backup.service'),
    'platform-freshness': ('platform-freshness', 'platform-canary-backup-freshness.service'),
    'fast-cut-commerce-backup': ('commerce-backup', 'flexperiment-fast-cut-canary-backup.service'),
    'fast-cut-commerce-freshness': ('commerce-freshness', 'flexperiment-fast-cut-canary-freshness.service'),
}
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


def notify(event, config, send=request, kind=None, history='', channels=CHANNELS):
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
    for channel in channels:
        try:
            outcomes[channel] = send(channel, config, bodies[channel], event_id)
        except Exception:
            outcomes[channel] = {'result': 'UNKNOWN'}
    return {'event': event, 'kind': kind, 'reference': event_id, 'timestamp': timestamp, 'channels': outcomes}


def accepted(outcome):
    return outcome['result'] in ['ACCEPTED', 'DELIVERED']


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
    # channels: when each channel last acknowledged a failure notice of this incident.
    # recoveredAt: 0 while failing; once the service recovered, only recovery delivery is pending.
    if not isinstance(state, dict) or set(state) != {'openedAt', 'suppressed', 'channels', 'recoveredAt', 'source'} \
            or not all(type(state[k]) is int and state[k] >= 0 for k in ['openedAt', 'recoveredAt']) \
            or not isinstance(state['suppressed'], dict) or set(state['suppressed']) != set(CHANNELS) \
            or not all(type(v) is int and v >= 0 for v in state['suppressed'].values()) \
            or not (state['source'] is None or valid_source(state['source'])) \
            or not isinstance(state['channels'], dict) or not set(state['channels']) <= set(CHANNELS) \
            or not all(type(v) is int and v > 0 for v in state['channels'].values()):
        return None
    return state


def write_state(path, state):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(json.dumps(state)); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, path)


def history(state, channel, now=None):
    since = datetime.datetime.fromtimestamp(state['openedAt'], datetime.timezone.utc).isoformat()
    until = '' if now is None else ', recovered ' + datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()
    return f'Failing since: {since}{until} ({state["suppressed"][channel]} repeated failures not re-sent)\n'


def valid_source(value):
    return (isinstance(value, dict) and set(value) == {'bootId', 'invocationId', 'exitUsec', 'recovered'}
            and type(value['exitUsec']) is int and value['exitUsec'] > 0 and type(value['recovered']) is bool
            and isinstance(value['bootId'], str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['bootId'])
            and isinstance(value['invocationId'], str) and re.fullmatch(r'[a-f0-9]{32}', value['invocationId']))


def read_source(binding):
    require(binding in SOURCE_BINDINGS)
    unit = SOURCE_BINDINGS[binding][1]
    result = subprocess.run(['systemctl', 'show', unit, '--no-pager',
        '--property=ActiveState,Result,InvocationID,ExecMainExitTimestampMonotonic'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
    require(result.returncode == 0 and len(result.stdout) <= 2048)
    rows = [line.split('=', 1) for line in result.stdout.decode('ascii').splitlines() if line]
    require(all(len(row) == 2 for row in rows) and len(rows) == 4)
    fields = dict(rows)
    require(set(fields) == {'ActiveState', 'Result', 'InvocationID', 'ExecMainExitTimestampMonotonic'})
    if fields['ActiveState'] not in ['inactive', 'failed']:
        return None  # A newer invocation is still active; its own callback will observe completion.
    require(fields['Result'] == 'success' if fields['ActiveState'] == 'inactive' else fields['Result'] != 'success')
    value = {'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
             'invocationId': fields['InvocationID'], 'exitUsec': int(fields['ExecMainExitTimestampMonotonic']),
             'recovered': fields['ActiveState'] == 'inactive'}
    require(valid_source(value))
    return value


def handle(event, config, send=None, state_dir=None, now=None, recovered=False, source=None):
    require(event in EVENTS and not (recovered and event == 'probe'))
    require(source is None or source in SOURCE_BINDINGS and SOURCE_BINDINGS[source][0] == event)
    send = send or request
    if event == 'probe':
        return {'event': event, 'result': 'SENT', 'notifications': [notify(event, config, send)]}
    directory = state_dir or STATE
    key = source or event
    lock = os.open(directory / (key + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        observed = None
        if source:
            try:
                observed = read_source(source)
            except Exception:
                # An unknown source can alert, but can never close/suppress an incident.
                notifications = [] if recovered else [notify(event, config, send)]
                return {'event': event, 'result': 'SOURCE_UNVERIFIED', 'notifications': notifications}
            if observed is None or observed['recovered'] != recovered:
                return {'event': event, 'result': 'IGNORED_STALE_SOURCE'}
        return transition(event, config, send, directory / (key + '.json'), int((now or time.time)()), recovered, observed)
    finally:
        os.close(lock)


def transition(event, config, send, path, at, recovered, observed=None):
    state = read_state(path)
    if state is not None and observed and state['source']:
        previous = state['source']
        if observed['bootId'] == previous['bootId'] and observed['exitUsec'] < previous['exitUsec']:
            return {'event': event, 'result': 'IGNORED_STALE_SOURCE'}
        if observed['bootId'] != previous['bootId'] and not recovered:
            state = None
    if recovered:
        if state is None or not state['channels']:
            path.unlink(missing_ok=True)
            return {'event': event, 'result': 'NO_OPEN_INCIDENT'}
        state['recoveredAt'] = state['recoveredAt'] or at
        state['source'] = observed or state['source']
        notifications = []
        for channel in CHANNELS:
            if channel not in state['channels']: continue
            result = notify(event, config, send, 'recovered', history(state, channel, state['recoveredAt']), [channel])
            notifications.append(result)
            if accepted(result['channels'][channel]): del state['channels'][channel]
        if state['channels']: write_state(path, state)
        else: path.unlink(missing_ok=True)
        return {'event': event, 'result': 'SENT', 'notifications': notifications}
    if state is None or state['recoveredAt']:
        state = {'openedAt': at, 'suppressed': {c: 0 for c in CHANNELS}, 'channels': {}, 'recoveredAt': 0, 'source': observed}
    state['source'] = observed or state['source']
    due = {c: 'reminder' if c in state['channels'] else 'opened' for c in CHANNELS
           if c not in state['channels'] or at - state['channels'][c] >= REMINDER_SECONDS}
    for channel in CHANNELS:
        if channel not in due: state['suppressed'][channel] += 1
    if not due:
        write_state(path, state)
        return {'event': event, 'result': 'SUPPRESSED', 'suppressed': state['suppressed']}
    notifications = []
    for channel in CHANNELS:
        if channel not in due: continue
        kind = due[channel]
        result = notify(event, config, send, kind, history(state, channel) if kind == 'reminder' else '', [channel])
        notifications.append(result)
        if accepted(result['channels'][channel]):
            state['channels'][channel] = at
            state['suppressed'][channel] = 0
    write_state(path, state)
    return {'event': event, 'result': 'SENT', 'notifications': notifications}


def running_as_root():
    return os.geteuid() == 0


def main():
    args = sys.argv[1:]
    recovered = len(args) == 2 and args[0] == '--recovered'
    require(running_as_root() and (len(args) == 1 or recovered) and args[-1] in set(SOURCE_BINDINGS) | {'probe'}
            and not (recovered and args[-1] == 'probe'))
    binding = args[-1]
    event = 'probe' if binding == 'probe' else SOURCE_BINDINGS[binding][0]
    result = handle(event, load_config(), recovered=recovered, source=None if binding == 'probe' else binding)
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['result'] != 'SOURCE_UNVERIFIED' and all(accepted(o) for n in result.get('notifications', []) for o in n['channels'].values()) else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"result":"ALERT_CONFIGURATION_OR_EXECUTION_HOLD"}')
        sys.exit(1)
