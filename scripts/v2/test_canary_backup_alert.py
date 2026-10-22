"""Isolated alert contracts. Never contacts a provider or reads owner secrets."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('alerts', Path(__file__).with_name('canary-backup-alert.py'))
alerts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alerts)
CONFIG = {'notisendKey': 'SECRET_NOTISEND', 'telebuzzyKey': 'SECRET_TELEBUZZY',
          'fromEmail': 'noreply@flexperiment.ru', 'fromName': 'Flexperiment', 'replyTo': 'art@flexperiment.ru'}


class Response:
    status = 200
    def __init__(self, body): self.body = body
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size): return self.body[:size]


class CanaryAlerts(unittest.TestCase):
    def test_fixed_canary_scope_no_production_or_arbitrary_event(self):
        for event in ['production', 'commerce-backup;cat /secrets', 'jwt', '']:
            with self.assertRaises(ValueError): alerts.notify(event, CONFIG)

    def test_both_channels_independent_after_transport_exception(self):
        seen = []
        def send(channel, *_):
            seen.append(channel)
            if channel == 'notisend': raise ValueError(CONFIG['notisendKey'])
            return {'result': 'ACCEPTED'}
        result = alerts.notify('probe', CONFIG, send)
        self.assertEqual(seen, ['notisend', 'telebuzzy'])
        self.assertEqual(result['channels']['notisend'], {'result': 'UNKNOWN'})
        self.assertNotIn('SECRET', json.dumps(result))

    def test_payloads_fixed_no_secret_database_logs_or_email_to_telebuzzy(self):
        sent = []
        def send(channel, config, body, key):
            sent.append((channel, body, key)); return {'result': 'ACCEPTED'}
        for event in alerts.EVENTS: alerts.notify(event, CONFIG, send)
        for channel, body, key in sent:
            self.assertNotIn('SECRET', json.dumps(body))
            self.assertIn('CANARY', body['title' if channel == 'telebuzzy' else 'subject'])
            if channel == 'notisend': self.assertEqual(body['to'], 'accidents@flexperiment.ru')
            else:
                self.assertNotIn('@', json.dumps(body))
                self.assertEqual(body['reference'], key)
                self.assertEqual(set(body), {'title','severity','app','action','event','reference','timestamp'})

    def test_transport_fixed_https_bearer_post_no_redirect_and_telebuzzy_idempotency(self):
        for channel in alerts.URLS:
            with patch.object(alerts.urllib.request, 'build_opener') as build:
                build.return_value.open.return_value = Response(b'{"id":1,"status":"queued"}')
                result = alerts.request(channel, CONFIG, {}, 'fixed-event-id')
                req = build.return_value.open.call_args.args[0]
                self.assertEqual(req.full_url, alerts.URLS[channel]); self.assertEqual(req.method, 'POST')
                self.assertEqual(build.return_value.open.call_args.kwargs['timeout'], 10)
                self.assertIsInstance(build.call_args.args[0], alerts.NoRedirect)
                if channel == 'telebuzzy': self.assertEqual(req.get_header('Idempotency-key'), 'fixed-event-id')
                self.assertEqual(result['result'], 'ACCEPTED')

    def test_notisend_status_acceptance_is_not_delivery(self):
        for status, expected in [('queued','ACCEPTED'),('sent','ACCEPTED'),('delivered','DELIVERED'),('hard_bounced','UNKNOWN')]:
            with patch.object(alerts.urllib.request, 'build_opener') as build:
                build.return_value.open.return_value=Response(json.dumps({'id':17,'status':status}).encode())
                self.assertEqual(alerts.request('notisend',CONFIG,{},'id')['result'],expected)

    def test_reflected_secret_malformed_oversized_and_unbounded_id_never_escape(self):
        for body in [b'badSECRET', b'x' * (alerts.MAX_BYTES+1),
                     b'{"id":"SECRET with whitespace","status":"delivered"}',
                     b'{"id":"SECRET_NOTISEND","status":"delivered"}',
                     b'{"errors":"SECRET_NOTISEND"}', b'[]', b'{"id":true,"status":"delivered"}']:
            with patch.object(alerts.urllib.request, 'build_opener') as build:
                build.return_value.open.return_value=Response(body)
                outcome=alerts.request('notisend',CONFIG,{},'id')
                self.assertNotIn('SECRET',json.dumps(outcome));self.assertNotIn(outcome['result'],['ACCEPTED','DELIVERED'])

    def test_http_and_transport_errors_are_bounded_and_never_retried(self):
        for error in [ValueError('SECRET_TELEBUZZY'), urllib.error.HTTPError('https://SECRET',401,'SECRET',{},io.BytesIO(b'SECRET'))]:
            with patch.object(alerts.urllib.request, 'build_opener') as build:
                build.return_value.open.side_effect=error
                outcome=alerts.request('telebuzzy',CONFIG,{},'id')
                self.assertNotIn('SECRET',json.dumps(outcome));self.assertEqual(build.return_value.open.call_count,1)

    def test_redirect_handler_refuses_secret_forwarding(self):
        self.assertIsNone(alerts.NoRedirect().redirect_request(None,None,302,'x',{},'https://foreign.example'))

    def test_root_only_custody_and_schema(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'config';path.write_text(json.dumps(CONFIG));path.chmod(0o600)
            info=path.stat()
            with patch.object(Path,'lstat',return_value=type('Info',(),{'st_mode':info.st_mode,'st_uid':0,'st_size':info.st_size})()):
                self.assertEqual(alerts.load_config(path),CONFIG)
            for mutation in [{**CONFIG,'url':'https://foreign.example'}, {**CONFIG,'telebuzzyKey':'secret\nleak'}]:
                path.write_text(json.dumps(mutation))
                with patch.object(Path,'lstat',return_value=type('Info',(),{'st_mode':info.st_mode,'st_uid':0,'st_size':1000})()), self.assertRaises(ValueError): alerts.load_config(path)
            path.chmod(0o644)
            with self.assertRaises(ValueError): alerts.load_config(path)
            link=Path(temp)/'symlink';link.symlink_to(path)
            with self.assertRaises(ValueError): alerts.load_config(link)

    def test_systemd_wiring_never_changes_production_template(self):
        root=Path(__file__).resolve().parents[2];units=root/'deploy/v2'
        expected={'commerce-backup':'canary-alert-commerce-backup.conf','platform-backup':'canary-alert-platform-backup.conf',
                  'platform-freshness':'canary-alert-platform-freshness.conf','commerce-freshness':'commerce-canary-backup-freshness.service',
                  'probe':'canary-alert-probe.service'}
        for event,file in expected.items():
            self.assertIn('OnFailure=flexperiment-v2-canary-alert@'+event+'.service',(units/file).read_text())
        self.assertNotIn('OnFailure=',(root/'deploy/host/flexperiment-commerce-v2-backup@.service').read_text())
        self.assertIn('canary check',(units/'commerce-canary-backup-freshness.service').read_text())
        self.assertNotIn('production',(units/'commerce-canary-backup-freshness.service').read_text())

    def incident(self, temp, event, at, send, recovered=False):
        return alerts.handle(event, CONFIG, send=send, state_dir=Path(temp), now=lambda: at, recovered=recovered)

    def test_repeated_failure_is_sent_once_then_reminded_then_recovered_once(self):
        sent = []
        def send(channel, config, body, key):
            sent.append((channel, body)); return {'result': 'ACCEPTED'}
        with tempfile.TemporaryDirectory() as temp:
            opened = self.incident(temp, 'commerce-freshness', 1_000_000, send)
            self.assertEqual((opened['kind'], len(sent)), ('opened', 2))
            for hour in range(1, 6):
                quiet = self.incident(temp, 'commerce-freshness', 1_000_000 + hour * 3600, send)
                self.assertEqual(quiet['result'], 'SUPPRESSED')
            self.assertEqual(len(sent), 2)
            reminder = self.incident(temp, 'commerce-freshness', 1_000_000 + alerts.REMINDER_SECONDS, send)
            self.assertEqual((reminder['kind'], len(sent)), ('reminder', 4))
            self.assertIn('still failing', sent[-1][1]['title'])
            self.assertIn('5 repeated failures not re-sent', sent[-2][1]['text'])
            recovered = self.incident(temp, 'commerce-freshness', 1_000_000 + 30_000, send, recovered=True)
            self.assertEqual((recovered['kind'], len(sent)), ('recovered', 6))
            self.assertIn('recovered', sent[-1][1]['title'])
            self.assertEqual(sent[-1][1]['severity'], 'info')
            self.assertEqual(list(Path(temp).iterdir()), [])
            again = self.incident(temp, 'commerce-freshness', 1_000_000 + 40_000, send)
            self.assertEqual(again['kind'], 'opened')

    def test_success_without_open_incident_contacts_no_provider(self):
        def send(*_): raise AssertionError('NO_PROVIDER_CALL_EXPECTED')
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(self.incident(temp, 'commerce-backup', 1, send, recovered=True)['result'], 'NO_OPEN_INCIDENT')

    def test_incidents_are_independent_per_event(self):
        sent = []
        def send(channel, config, body, key):
            sent.append(channel); return {'result': 'ACCEPTED'}
        with tempfile.TemporaryDirectory() as temp:
            self.incident(temp, 'commerce-backup', 1, send)
            self.assertEqual(self.incident(temp, 'commerce-freshness', 2, send)['kind'], 'opened')
            self.assertEqual(len(sent), 4)

    def test_unaccepted_notification_is_not_recorded_so_next_failure_sends_again(self):
        with tempfile.TemporaryDirectory() as temp:
            refused = self.incident(temp, 'commerce-backup', 1, lambda *_: {'result': 'REFUSED', 'httpStatus': 401})
            self.assertEqual(refused['kind'], 'opened')
            sent = []
            def send(channel, *_):
                sent.append(channel); return {'result': 'ACCEPTED'}
            self.assertEqual(self.incident(temp, 'commerce-backup', 2, send)['kind'], 'opened')
            self.assertEqual(len(sent), 2)

    def test_probe_is_never_suppressed_or_recorded(self):
        sent = []
        def send(channel, *_):
            sent.append(channel); return {'result': 'ACCEPTED'}
        with tempfile.TemporaryDirectory() as temp:
            for at in [1, 2]: self.assertEqual(self.incident(temp, 'probe', at, send)['kind'], 'probe')
            self.assertEqual((len(sent), list(Path(temp).iterdir())), (4, []))

    def test_state_is_private_and_unreadable_state_fails_toward_notifying(self):
        ok = lambda *_: {'result': 'ACCEPTED'}
        with tempfile.TemporaryDirectory() as temp:
            self.incident(temp, 'commerce-backup', 1, ok)
            [state] = Path(temp).iterdir()
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('SECRET', state.read_text())
            for corrupt in ['{not json', json.dumps({'openedAt': 'SECRET', 'lastSentAt': []}), '[]']:
                state.write_text(corrupt)
                self.assertEqual(self.incident(temp, 'commerce-backup', 2, ok)['kind'], 'opened')
            state.unlink(); state.symlink_to(Path(temp) / 'elsewhere')
            self.assertEqual(self.incident(temp, 'commerce-backup', 3, ok)['kind'], 'opened')

    def test_cli_exits_zero_when_suppressed_and_recovery_flag_is_exact(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(alerts, 'STATE', Path(temp)), \
             patch.object(alerts, 'load_config', return_value=CONFIG), patch.object(alerts.os, 'geteuid', return_value=0), \
             patch.object(alerts, 'request', return_value={'result': 'ACCEPTED'}) as provider:
            for argv in [['x', 'commerce-backup'], ['x', 'commerce-backup'],
                         ['x', '--recovered', 'commerce-backup'], ['x', '--recovered', 'commerce-backup']]:
                with patch.object(alerts.sys, 'argv', argv), patch('sys.stdout', new_callable=io.StringIO):
                    self.assertEqual(alerts.main(), 0)
            self.assertEqual(provider.call_count, 4)
            for argv in [['x', '--recovered', 'probe'], ['x', '--recover', 'commerce-backup'], ['x', 'commerce-backup', 'extra']]:
                with patch.object(alerts.sys, 'argv', argv), self.assertRaises(ValueError): alerts.main()

    def test_every_failure_hook_has_a_recovery_hook_sharing_private_state(self):
        root = Path(__file__).resolve().parents[2]
        units = [path for path in (root/'deploy/v2').rglob('*') if path.is_file() and 'OnFailure=flexperiment-v2-canary-alert@' in path.read_text()]
        self.assertGreaterEqual(len(units), 7)
        for path in units:
            event = path.read_text().split('OnFailure=flexperiment-v2-canary-alert@')[1].split('.service')[0]
            if event == 'probe':
                self.assertNotIn('OnSuccess=', path.read_text())
            else:
                self.assertIn('OnSuccess=flexperiment-v2-canary-recovery@' + event + '.service', path.read_text(), path)
        for name, flag in [('flexperiment-v2-canary-alert@.service', ' %i'), ('flexperiment-v2-canary-recovery@.service', ' --recovered %i')]:
            unit = (root/'deploy/v2'/name).read_text()
            self.assertIn('StateDirectory=flexperiment-v2-canary-alerts\n', unit)
            self.assertIn('StateDirectoryMode=0700\n', unit)
            self.assertIn('canary-backup-alert.py' + flag + '\n', unit)
            self.assertIn('ProtectSystem=strict\n', unit)
        self.assertEqual(alerts.STATE, Path('/var/lib/flexperiment-v2-canary-alerts'))

    def test_causal_independent_channel_regression(self):
        result=unittest.TestResult()
        def wrong(event,config,send): return {'channels':{'notisend':send('notisend',config,{},'id')}}
        with patch.object(alerts,'notify',wrong):
            CanaryAlerts('test_both_channels_independent_after_transport_exception').run(result)
        self.assertFalse(result.wasSuccessful())


if __name__ == '__main__': unittest.main()
