"""Pinned installed canary systemd contract. No operation runs on import.

The controller owns fsynced one-shot intents and runtime/admission checks.
This module never accepts a target/unit name from an operator.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess

from art337_erasure_requalification import Refusal, refuse

BACKUP_TIMER = 'flexperiment-commerce-v2-backup@canary.timer'
BACKUP_SERVICE = 'flexperiment-commerce-v2-backup@canary.service'
FRESHNESS_TIMER = 'commerce-canary-backup-freshness.timer'
FRESHNESS_SERVICE = 'commerce-canary-backup-freshness.service'
TIMERS = (BACKUP_TIMER, FRESHNESS_TIMER)
SERVICES = (BACKUP_SERVICE, FRESHNESS_SERVICE)
ALERTS = ('flexperiment-v2-canary-alert@commerce-backup.service',
          'flexperiment-v2-canary-alert@commerce-freshness.service')
HELPER = '/usr/local/lib/flexperiment-v2/scheduled-backup.py'
FILES = {
    '/etc/systemd/system/flexperiment-commerce-v2-backup@.timer': '1d7be448ac3d1d58d506662cbdb168d5fe8217a18c8f9d531a600f636861c867',
    '/etc/systemd/system/flexperiment-commerce-v2-backup@.service': 'c0c4f6ab90d351ddb089b4914983509bd1603a726c5dd312b5a51fc294ce39f5',
    '/etc/systemd/system/commerce-canary-backup-freshness.timer': '6fd601a7908d8492b5b1cbfa1e9925e0bf258ca5dde34b034cca399de64e63b3',
    '/etc/systemd/system/commerce-canary-backup-freshness.service': '99b5fc5f94e88675c71ea085f3c093a69ad3e591f08ee4ee4355c1b0112973ab',
    '/etc/systemd/system/flexperiment-commerce-v2-backup@canary.service.d/canary-alert.conf': 'e5b0326630714c840bb54cbbaeeaf95a8e2e0c8c22c06dddf29381c0bd0dca01',
    HELPER: 'b26c0e15d974b638f068885a0031ad0403c203974cb05391edc680fbf87e6b1f',
}
CONTRACTS = {
    BACKUP_TIMER: {'FragmentPath': '/etc/systemd/system/flexperiment-commerce-v2-backup@.timer',
                   'DropInPaths': '', 'Triggers': BACKUP_SERVICE, 'Unit': BACKUP_SERVICE, 'Persistent': 'yes'},
    FRESHNESS_TIMER: {'FragmentPath': '/etc/systemd/system/commerce-canary-backup-freshness.timer',
                      'DropInPaths': '', 'Triggers': FRESHNESS_SERVICE, 'Unit': FRESHNESS_SERVICE, 'Persistent': 'no'},
    BACKUP_SERVICE: {'FragmentPath': '/etc/systemd/system/flexperiment-commerce-v2-backup@.service',
                     'DropInPaths': '/etc/systemd/system/flexperiment-commerce-v2-backup@canary.service.d/canary-alert.conf',
                     'TriggeredBy': BACKUP_TIMER, 'Type': 'oneshot', 'User': 'root',
                     'OnFailure': ALERTS[0]},
    FRESHNESS_SERVICE: {'FragmentPath': '/etc/systemd/system/commerce-canary-backup-freshness.service',
                        'DropInPaths': '', 'TriggeredBy': FRESHNESS_TIMER, 'Type': 'oneshot', 'User': 'root',
                        'OnFailure': ALERTS[1]},
}
PROPERTIES = ('Id', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath', 'DropInPaths',
              'ExecStart', 'User', 'Type', 'Triggers', 'TriggeredBy', 'Job', 'MainPID', 'ControlPID',
              'Result', 'Unit', 'Persistent', 'Transient', 'OnFailure', 'ControlGroup')
CENSUS_PATTERNS = ('flexperiment-commerce-v2-backup@canary*', 'commerce-canary-backup*',
                   'flexperiment-v2-canary-alert@commerce-*')


def command(args, timeout=30):
    try:
        return subprocess.check_output(args, timeout=timeout, stderr=subprocess.DEVNULL).decode()
    except (OSError, subprocess.SubprocessError):
        refuse('CANARY_TIMER_COMMAND_UNKNOWN')


def file_hash(path):
    file = Path(path)
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 \
            or stat.S_IMODE(info.st_mode) != 0o644:
        refuse('CANARY_TIMER_FILE_CUSTODY_DRIFT')
    return hashlib.sha256(file.read_bytes()).hexdigest()


def show(unit):
    text = command(['systemctl', 'show', unit, '--property=' + ','.join(PROPERTIES)])
    pairs = [line.split('=', 1) for line in text.splitlines() if '=' in line]
    if len(pairs) != len({key for key, _ in pairs}):
        refuse('CANARY_TIMER_STATE_UNKNOWN')
    state = dict(pairs)
    if state.get('Id') != unit or state.get('LoadState') != 'loaded' or state.get('Transient') != 'no':
        refuse('CANARY_TIMER_STATE_UNKNOWN')
    return state


def no_processes():
    """Catch orphaned owner helpers too, without emitting any process arguments."""
    for process in Path('/proc').iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            args = (process / 'cmdline').read_bytes().split(b'\0')
            if any(arg == HELPER.encode() and args[i + 1:i + 3] in
                   ([b'canary', b'backup'], [b'canary', b'check']) for i, arg in enumerate(args)):
                refuse('CANARY_BACKUP_PROCESS_ACTIVE')
        except (FileNotFoundError, ProcessLookupError):
            continue


def quiescent(state, failed=True):
    permitted = ('inactive', 'failed') if failed else ('inactive',)
    if state.get('ActiveState') not in permitted or state.get('SubState') not in ('dead', 'failed') \
            or state.get('Job') or state.get('MainPID') != '0' or state.get('ControlPID') != '0':
        refuse('CANARY_BACKUP_JOB_ACTIVE_OR_UNKNOWN')
    group = state.get('ControlGroup')
    if group:
        if not group.startswith('/system.slice/') or '..' in group.split('/'):
            refuse('CANARY_BACKUP_CGROUP_UNKNOWN')
        root = Path('/sys/fs/cgroup') / group.lstrip('/')
        if root.exists() and any(path.read_text().strip() for path in root.rglob('cgroup.procs')):
            refuse('CANARY_BACKUP_CGROUP_ACTIVE')


def capture():
    hashes = {path: file_hash(path) for path in FILES}
    if hashes != FILES:
        refuse('CANARY_TIMER_INSTALLED_CODE_DRIFT')
    states = {unit: show(unit) for unit in (*TIMERS, *SERVICES, *ALERTS)}
    for unit, expected in CONTRACTS.items():
        for key, value in expected.items():
            actual = states[unit].get(key)
            # systemd can unload an inactive timer between two show calls.
            # The service's dynamic reverse edge then disappears. The pinned
            # fragment still declares the target; permit only this empty edge
            # with its timer independently disabled/inactive. Unknown edges HOLD.
            unloaded_reverse = key == 'TriggeredBy' and actual == '' and value in TIMERS \
                and states[value].get('ActiveState') == 'inactive' \
                and states[value].get('UnitFileState') == 'disabled'
            if actual != value and not unloaded_reverse:
                refuse('CANARY_TIMER_UNIT_BINDING_DRIFT')
    for service, verb in zip(SERVICES, ('backup', 'check')):
        argv = re.findall(r'argv\[\]=(.*?) ; ignore_errors=', states[service].get('ExecStart', ''))
        if argv != ['/usr/bin/python3 ' + HELPER + ' canary ' + verb]:
            refuse('CANARY_TIMER_EXECUTION_SCOPE_DRIFT')
        quiescent(states[service])
    for alert in ALERTS:
        quiescent(states[alert])
    known = set(states)
    text = command(['systemctl', 'list-units', '--all', '--no-legend', '--no-pager',
                    *CENSUS_PATTERNS])
    for line in text.splitlines():
        values = line.split()
        if values and (values[1] if values[0] == '●' else values[0]) not in known:
            refuse('CANARY_UNKNOWN_BACKUP_UNIT')
    jobs = command(['systemctl', 'list-jobs', '--no-legend', '--no-pager'])
    if any(set(line.split()) & known for line in jobs.splitlines()):
        refuse('CANARY_PENDING_BACKUP_JOB')
    no_processes()
    return {'files': hashes, 'units': states}


def verify_isolated(snapshot=None):
    snapshot = capture() if snapshot is None else snapshot
    for timer in TIMERS:
        value = snapshot['units'][timer]
        if value.get('UnitFileState') != 'disabled' or value.get('ActiveState') != 'inactive' \
                or value.get('SubState') != 'dead' or value.get('Job'):
            refuse('CANARY_COMMERCE_TIMER_NOT_ISOLATED')
    for service in SERVICES:
        quiescent(snapshot['units'][service], failed=False)
    return snapshot


def isolate():
    capture()  # Never terminate an in-flight/uncertain backup or alert.
    command(['systemctl', 'disable', '--now', *TIMERS])
    capture()  # A racing service must HOLD, not be killed after remote side effects.
    command(['systemctl', 'stop', *SERVICES])
    command(['systemctl', 'reset-failed', *SERVICES])
    return verify_isolated()


def run_backup():
    verify_isolated()
    command(['systemctl', 'start', BACKUP_SERVICE], timeout=930)
    current = verify_isolated()
    if current['units'][BACKUP_SERVICE].get('Result') != 'success':
        refuse('CANARY_SCHEDULED_BACKUP_FAILED')
    return current


def restore():
    verify_isolated()
    command(['systemctl', 'start', FRESHNESS_SERVICE], timeout=45)
    current = verify_isolated()
    if current['units'][FRESHNESS_SERVICE].get('Result') != 'success':
        refuse('CANARY_FRESHNESS_CHECK_FAILED')
    command(['systemctl', 'enable', '--now', *TIMERS])
    # Activation may trigger OnBootSec immediately. The separate read-only
    # verifier waits for completion and requires the latest archive's proof.
    return {'timers': list(TIMERS), 'state': 'ACTIVATION_RETURNED_REQUIRES_READBACK'}


def run_rearmed_backup():
    """A separate known start after activation anchors OnUnitActiveSec.

    systemd may GC the first completed service while its timer is disabled.
    Starting it with the enabled timer retaining its reverse relationship
    restores the recurring deadline. Never retry an uncertain prior start.
    """
    snapshot = capture()
    for unit in TIMERS:
        value = snapshot['units'][unit]
        if value.get('UnitFileState') != 'enabled' or value.get('ActiveState') != 'active' \
                or value.get('SubState') not in ('waiting', 'elapsed') or value.get('Job'):
            refuse('CANARY_TIMER_NOT_ACTIVATED')
    for service in SERVICES:
        quiescent(snapshot['units'][service], failed=False)
    command(['systemctl', 'start', BACKUP_SERVICE], timeout=930)
    # Final waiting/next-archive proof is deliberately the separate observer.
    current = capture()
    if current['units'][BACKUP_SERVICE].get('Result') != 'success':
        refuse('CANARY_SCHEDULED_BACKUP_FAILED')
    return current


def verify_restored():
    snapshot = capture()
    for timer in TIMERS:
        value = snapshot['units'][timer]
        if value.get('UnitFileState') != 'enabled' or value.get('ActiveState') != 'active' \
                or value.get('SubState') != 'waiting' or value.get('Job'):
            refuse('CANARY_TIMER_SCHEDULE_NOT_RESTORED')
    for service in SERVICES:
        quiescent(snapshot['units'][service], failed=False)
        if snapshot['units'][service].get('Result') != 'success':
            refuse('CANARY_TIMER_SERVICE_NOT_SUCCESSFUL')
    return snapshot
