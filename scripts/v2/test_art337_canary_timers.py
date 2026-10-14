"""No live systemd: state/trigger/command failures and bounded target scope."""
import contextlib
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).parent))
import art337_canary_timers as t
from art337_erasure_requalification import Refusal


def states(isolated=False):
    result={}
    for unit in (*t.TIMERS,*t.SERVICES,*t.ALERTS):
        result[unit]={'Id':unit,'LoadState':'loaded','Transient':'no','Job':'','MainPID':'0','ControlPID':'0',
                      'ControlGroup':'','Result':'success','ActiveState':'inactive','SubState':'dead',
                      **t.CONTRACTS.get(unit,{})}
    for timer in t.TIMERS:
        result[timer].update(UnitFileState='disabled' if isolated else 'enabled',
                             ActiveState='inactive' if isolated else 'active',SubState='dead' if isolated else 'waiting')
    for unit,verb in zip(t.SERVICES,('backup','check')):
        result[unit]['ExecStart']='{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 '+t.HELPER+' canary '+verb+' ; ignore_errors=no ; }'
    return result


@contextlib.contextmanager
def backend(isolated=False):
    data=states(isolated);jobs=[''];units=[''];commands=[]
    def command(args,timeout=30):
        commands.append(args)
        if args[1]=='show':return '\n'.join(k+'='+v for k,v in data[args[2]].items())
        if args[1]=='list-jobs':return jobs[0]
        if args[1]=='list-units':return units[0]
        if args[1]=='disable':
            for unit in t.TIMERS:data[unit].update(UnitFileState='disabled',ActiveState='inactive',SubState='dead')
        elif args[1]=='enable':
            for unit in t.TIMERS:data[unit].update(UnitFileState='enabled',ActiveState='active',SubState='waiting')
        elif args[1]=='stop' or args[1]=='reset-failed':
            for unit in t.SERVICES:data[unit].update(ActiveState='inactive',SubState='dead',Result='success')
        elif args[1]=='start':data[args[2]].update(ActiveState='inactive',SubState='dead',Result='success')
        return ''
    with patch.object(t,'command',side_effect=command),patch.object(t,'file_hash',side_effect=lambda name:t.FILES[name]),patch.object(t,'no_processes'):
        yield data,jobs,units,commands


class TimerSafety(unittest.TestCase):
    def test_enabled_waiting_timers_are_not_isolated_even_without_writers(self):
        with backend(),self.assertRaisesRegex(Refusal,'NOT_ISOLATED'):t.verify_isolated()

    def test_exact_unit_bindings_script_and_production_argument_drift_refuse(self):
        changes=[lambda d:d[t.BACKUP_SERVICE].update(TriggeredBy='unexpected.timer'),
                 lambda d:d[t.BACKUP_SERVICE].update(DropInPaths='unexpected.conf'),
                 lambda d:d[t.BACKUP_SERVICE].update(ExecStart='{ argv[]=/usr/bin/python3 '+t.HELPER+' production backup ; ignore_errors=no ; }'),
                 lambda d:d[t.FRESHNESS_TIMER].update(Unit='production.service'),
                 lambda d:d[t.BACKUP_SERVICE].update(User='unknown')]
        for change in changes:
            with self.subTest(change=change),backend() as (data,_,_,commands):
                change(data)
                with self.assertRaises(Refusal):t.isolate()
                self.assertFalse(any(c[1] in ('disable','stop','enable','start') for c in commands))

    def test_unknown_unit_pending_job_pid_or_alert_blocks_before_changes(self):
        changes=[lambda d,j,u:j.__setitem__(0,'42 '+t.BACKUP_SERVICE+' start waiting'),
                 lambda d,j,u:u.__setitem__(0,'commerce-canary-backup-unknown.service loaded inactive dead'),
                 lambda d,j,u:d[t.BACKUP_SERVICE].update(MainPID='42'),
                 lambda d,j,u:d[t.ALERTS[0]].update(ActiveState='activating',SubState='start'),
                 lambda d,j,u:d[t.FRESHNESS_SERVICE].update(Job='55')]
        for change in changes:
            with self.subTest(change=change),backend() as (data,jobs,units,commands):
                change(data,jobs,units)
                with self.assertRaises(Refusal):t.isolate()
                self.assertFalse(any(c[1] in ('disable','stop','enable') for c in commands))

    def test_helper_or_fragment_content_change_refuses(self):
        with backend(),patch.object(t,'file_hash',return_value='0'*64),self.assertRaisesRegex(Refusal,'INSTALLED_CODE_DRIFT'):t.capture()

    def test_isolation_disable_now_stop_reset_readback_only_exact_canary_units(self):
        with backend() as (data,_,_,commands):
            for unit in t.SERVICES:data[unit].update(ActiveState='failed',SubState='failed',Result='exit-code')
            snapshot=t.isolate();t.verify_isolated(snapshot)
            mutations=[c for c in commands if c[1] in ('disable','stop','reset-failed')]
            self.assertEqual(mutations,[['systemctl','disable','--now',*t.TIMERS],['systemctl','stop',*t.SERVICES],['systemctl','reset-failed',*t.SERVICES]])
            self.assertFalse(any('production' in ' '.join(c) for c in commands))

    def test_service_racing_disable_holds_without_kill(self):
        with backend() as (data,_,_,commands):
            underlying=t.command.side_effect
            def race(args,timeout=30):
                result=underlying(args,timeout)
                if args[1]=='disable':data[t.BACKUP_SERVICE].update(ActiveState='activating',SubState='start',MainPID='99')
                return result
            t.command.side_effect=race
            with self.assertRaisesRegex(Refusal,'JOB_ACTIVE'):t.isolate()
            self.assertFalse(any(c[1]=='stop' for c in commands))

    def test_failed_command_propagates_no_followup_mutation(self):
        with backend() as (_,_,_,commands):
            underlying=t.command.side_effect
            def fault(args,timeout=30):
                if args[1]=='disable':raise Refusal('COMMAND_UNKNOWN')
                return underlying(args,timeout)
            t.command.side_effect=fault
            with self.assertRaisesRegex(Refusal,'COMMAND_UNKNOWN'):t.isolate()
            self.assertFalse(any(c[1] in ('stop','reset-failed','enable') for c in commands))

    def test_backup_and_freshness_only_start_with_disabled_timers(self):
        with backend(isolated=True) as (_,_,_,commands):
            t.run_backup();self.assertIn(['systemctl','start',t.BACKUP_SERVICE],commands)
            result=t.restore();self.assertEqual(result['state'],'ACTIVATION_RETURNED_REQUIRES_READBACK')
            t.verify_restored();self.assertIn(['systemctl','start',t.FRESHNESS_SERVICE],commands)
        with backend(),self.assertRaisesRegex(Refusal,'NOT_ISOLATED'):t.run_backup()

    def test_activation_not_pass_while_automatic_onboot_backup_runs(self):
        with backend(isolated=True) as (data,_,_,_):
            t.restore();data[t.BACKUP_SERVICE].update(ActiveState='activating',SubState='start',MainPID='44')
            with self.assertRaisesRegex(Refusal,'JOB_ACTIVE'):t.verify_restored()

    def test_actual_orphan_helper_argv_detected_without_printing_arguments(self):
        class Process:
            name='999999'
            def __truediv__(self,key):return self
            def read_bytes(self):return b'python3\0'+t.HELPER.encode()+b'\0canary\0backup\0'
        with patch.object(Path,'iterdir',return_value=iter([Process()])),self.assertRaisesRegex(Refusal,'PROCESS_ACTIVE'):t.no_processes()


if __name__=='__main__':unittest.main()
