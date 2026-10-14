"""Real systemd on the disposable GitHub VM; never execute against the VPS.

Requires explicit test flag and root, creates only randomly named proof units.
No Docker, owner directory, merchant DB, keys, provider or actual canary units.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).parent))
import art337_canary_timers as t


@unittest.skipUnless(os.environ.get('ART337_ISOLATED_SYSTEMD')=='1','explicit disposable-VM proof only')
class RealSystemd(unittest.TestCase):
    def test_failed_services_isolate_restore_and_real_trigger_readbacks(self):
        self.assertEqual(os.geteuid(),0)
        prefix='art337-proof-'+uuid.uuid4().hex
        timers=(prefix+'-backup.timer',prefix+'-freshness.timer')
        services=(prefix+'-backup.service',prefix+'-freshness.service')
        alerts=(prefix+'-backup-alert.service',prefix+'-freshness-alert.service')
        files=[]
        def systemctl(*args):
            return subprocess.run(['systemctl',*args],check=True,capture_output=True,text=True,timeout=30).stdout
        with tempfile.TemporaryDirectory(prefix=prefix+'-') as temp:
            root=Path(temp);helper=root/'scheduled-backup.py';events=root/'events';fault=root/'fault';fault.touch()
            helper.write_text('import pathlib,sys\n'
                'p=pathlib.Path('+repr(str(events))+')\n'
                'with p.open("a") as f:f.write(sys.argv[2]+"\\n")\n'
                'sys.exit(1 if pathlib.Path('+repr(str(fault))+').exists() else 0)\n')
            helper.chmod(0o644)
            contracts={};hashes={str(helper):hashlib.sha256(helper.read_bytes()).hexdigest()}
            try:
                for i,(timer,service,alert,verb) in enumerate(zip(timers,services,alerts,('backup','check'))):
                    source=Path('/etc/systemd/system')/service
                    source.write_text('[Unit]\nDescription=ART337 isolated proof\nOnFailure='+alert+'\n'
                        '[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 '+str(helper)+' canary '+verb+'\n')
                    source.chmod(0o644);files.append(source);hashes[str(source)]=hashlib.sha256(source.read_bytes()).hexdigest()
                    contracts[service]={'FragmentPath':str(source),'DropInPaths':'','TriggeredBy':timer,
                                        'Type':'oneshot','User':'root','OnFailure':alert}
                    source=Path('/etc/systemd/system')/timer
                    source.write_text('[Unit]\nDescription=ART337 isolated timer\n[Timer]\nOnBootSec=0\nOnUnitActiveSec=12h\n'
                        'Persistent='+('true' if i==0 else 'false')+'\nUnit='+service+'\n[Install]\nWantedBy=timers.target\n')
                    source.chmod(0o644);files.append(source);hashes[str(source)]=hashlib.sha256(source.read_bytes()).hexdigest()
                    contracts[timer]={'FragmentPath':str(source),'DropInPaths':'','Triggers':service,
                                      'Unit':service,'Persistent':'yes' if i==0 else 'no'}
                    source=Path('/etc/systemd/system')/alert
                    source.write_text('[Unit]\nDescription=ART337 isolated alert (no external sends)\n'
                                      '[Service]\nType=oneshot\nExecStart=/usr/bin/true\n')
                    source.chmod(0o644);files.append(source)
                systemctl('daemon-reload');systemctl('enable','--now',*timers)
                patches={'BACKUP_TIMER':timers[0],'FRESHNESS_TIMER':timers[1],'BACKUP_SERVICE':services[0],
                         'FRESHNESS_SERVICE':services[1],'TIMERS':timers,'SERVICES':services,'ALERTS':alerts,
                         'HELPER':str(helper),'FILES':hashes,'CONTRACTS':contracts,'CENSUS_PATTERNS':(prefix+'*',)}
                with patch.multiple(t,**patches):
                    def wait_quiet():
                        deadline=time.monotonic()+20
                        while True:
                            try:return t.capture()
                            except t.Refusal:
                                if time.monotonic()>deadline:raise
                                time.sleep(.1)
                    deadline=time.monotonic()+20
                    while True:
                        before=wait_quiet()
                        if before['units'][services[0]]['ActiveState']=='failed':break
                        if time.monotonic()>deadline:self.fail('real timer did not trigger its initial synthetic failure')
                        time.sleep(.1)
                    self.assertEqual(before['units'][services[0]]['ActiveState'],'failed')
                    with self.assertRaises(t.Refusal):t.verify_isolated()
                    after=t.isolate();t.verify_isolated(after)
                    count=events.read_text();time.sleep(.2);self.assertEqual(count,events.read_text())
                    fault.unlink()  # Only this disposable proof's synthetic failure marker.
                    t.run_backup();self.assertTrue(events.read_text().endswith('backup\n'))
                    self.assertEqual(t.restore()['state'],'ACTIVATION_RETURNED_REQUIRES_READBACK')
                    wait_quiet();t.verify_restored()
                    self.assertIn('check',events.read_text().splitlines())
            finally:
                subprocess.run(['systemctl','disable','--now',*timers],capture_output=True)
                subprocess.run(['systemctl','stop',*services,*alerts],capture_output=True)
                for file in files:file.unlink(missing_ok=True)
                subprocess.run(['systemctl','daemon-reload'],capture_output=True)
                subprocess.run(['systemctl','reset-failed',*services,*alerts],capture_output=True)


if __name__=='__main__':unittest.main()
