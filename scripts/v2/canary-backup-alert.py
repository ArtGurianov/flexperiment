#!/usr/bin/env python3
"""Canary-only operator alerts. Fixed payloads; no runtime/DB/log access or retries."""
import datetime
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.error
import urllib.request
import uuid

CONFIG = Path('/root/flexperiment-v2-owner/canary-alerts.json')
EVENTS = {'commerce-backup', 'commerce-freshness', 'platform-backup', 'platform-freshness', 'probe'}
URLS = {'notisend': 'https://api.notisend.ru/v1/email/messages',
        'telebuzzy': 'https://telebuzzy.xyz/api/notify'}
MAX_BYTES = 16384


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


def notify(event, config, send=request):
    require(event in EVENTS)
    event_id = str(uuid.uuid4())
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    title = '[CANARY] Flexperiment backup alert' + (' TEST' if event == 'probe' else '')
    message = f'{title}\nEvent: {event}\nTime: {timestamp}\nReference: {event_id}\nCheck canary backup/freshness service status. No customer or database data included.'
    bodies = {
        'notisend': {'to': 'accidents@flexperiment.ru', 'from_email': config['fromEmail'],
                     'from_name': config['fromName'], 'subject': title, 'text': message,
                     'smtp_headers': {'Reply-To': config['replyTo']}},
        'telebuzzy': {'title': title, 'severity': 'info' if event == 'probe' else 'critical',
                     'app': 'flexperiment-v2-canary-backups', 'action': 'Check canary backups',
                     'event': event, 'reference': event_id, 'timestamp': timestamp},
    }
    outcomes = {}
    for channel in ['notisend', 'telebuzzy']:
        try:
            outcomes[channel] = send(channel, config, bodies[channel], event_id)
        except Exception:
            outcomes[channel] = {'result': 'UNKNOWN'}
    return {'event': event, 'reference': event_id, 'timestamp': timestamp, 'channels': outcomes}


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 2 and sys.argv[1] in EVENTS)
    result = notify(sys.argv[1], load_config())
    print(json.dumps(result, separators=(',', ':')))
    return 0 if all(v['result'] in ['ACCEPTED', 'DELIVERED'] for v in result['channels'].values()) else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"result":"ALERT_CONFIGURATION_OR_EXECUTION_HOLD"}')
        sys.exit(1)
