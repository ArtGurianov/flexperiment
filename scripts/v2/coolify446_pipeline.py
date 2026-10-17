"""Test-only replay of captured installed 4.4.6 source. Never live operations."""
import json
from pathlib import Path
import subprocess

FIXTURE = Path(__file__).with_name('fixtures') / 'coolify-4.4.6'


def replay(body, scenario=None, patch=None):
    payload = {'body': body, 'scenario': scenario or {}}
    if patch is not None:
        payload['patch'] = patch
    result = subprocess.run(['php', str(FIXTURE / 'image-pipeline-harness.php')],
                            input=json.dumps(payload), capture_output=True, text=True, timeout=15)
    if result.returncode or result.stderr.strip():
        raise RuntimeError('COOLIFY446_SOURCE_REPLAY_FAILED: ' + result.stderr[-2000:])
    return json.loads(result.stdout)
