#!/usr/bin/env python3
"""Real local registry + digest pull + target image runtime. CI/local only.

No Coolify, owner config, customer DB or provider credentials. The output
proves artifact transport, never live erasure admission or hard cut.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
import time
import urllib.request
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import art337_immutable_recovery as r


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, text=True)
    if result.returncode:
        # This test has only synthetic fixtures and a local registry; keep real
        # diagnostic output so CI failures can be repaired without blind retries.
        print(result.stdout[-8000:], file=sys.stderr)
        print(result.stderr[-4000:], file=sys.stderr)
        raise RuntimeError('ISOLATED_COMMAND_FAILED:' + args[1])
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    token = uuid.uuid4().hex
    registry, container = 'art337-registry-' + token, 'art337-runtime-' + token
    repository = None
    try:
        command(['docker', 'run', '-d', '--name', registry, '-p', '127.0.0.1::5000', 'registry:2'])
        port = json.loads(command(['docker', 'inspect', registry]))[0]['NetworkSettings']['Ports']['5000/tcp'][0]['HostPort']
        deadline = time.monotonic() + 15
        while True:
            try:
                with urllib.request.urlopen('http://127.0.0.1:' + port + '/v2/', timeout=1) as response:
                    if response.status != 200: raise RuntimeError('REGISTRY_NOT_READY')
                break
            except (OSError, RuntimeError):
                if time.monotonic() >= deadline: raise RuntimeError('REGISTRY_START_TIMEOUT')
                time.sleep(0.1)
        repository = 'localhost:' + port + '/flexperiment/art337-proof'
        tag = repository + ':isolated'
        command(['docker', 'tag', args.image, tag])
        command(['docker', 'push', tag])
        digests = json.loads(command(['docker', 'image', 'inspect', tag]))[0]['RepoDigests']
        digest = next(value.rsplit('@', 1)[1] for value in digests if value.startswith(repository + '@'))
        reference = repository + '@' + digest
        expected = r.inspect_artifact(reference, 'commerce-v2')
        command(['docker', 'image', 'rm', tag])
        # A new registry pull and a container created using the digest, not the
        # input tag. Compare registry/config descriptors, image ID and RootFS.
        r.verify_artifact(expected)
        command(['docker', 'run', '-d', '--name', container, '--network', 'none', '--read-only',
                 '--platform', 'linux/amd64', '--entrypoint', 'node', reference,
                 '-e', 'setInterval(()=>{},1000)'])
        live = r.verify_runtime(expected, container)
        # Runtime compatibility and both reviewed schemas are exercised inside
        # the very same image that was independently pulled from the registry.
        contract = command(['docker', 'run', '--rm', '--network', 'none', '--platform', 'linux/amd64',
            '--user', '0', '--entrypoint', 'node', reference, '/app/node_modules/vitest/vitest.mjs', 'run',
            'commerce-v2/test/erasure-restore.test.ts', 'commerce-v2/test/erasure-library-read.test.ts'])
        if 'passed' not in contract:
            raise RuntimeError('ISOLATED_ERASURE_CONTRACT_NOT_CONFIRMED')
        args.output.write_text(json.dumps({'state': 'ISOLATED_IMMUTABLE_TRANSPORT_PASS',
            'sourceCommit': r.TARGET, 'artifact': expected, 'runtime': live,
            'isolatedErasureContracts': 'PASS', 'liveExecution': 'NOT_PERFORMED'}, indent=2))
        print(json.dumps({'state': 'ISOLATED_IMMUTABLE_TRANSPORT_PASS', 'sourceCommit': r.TARGET,
                          'manifestDigest': digest, 'imageId': expected['imageId']}))
    finally:
        for name in (container, registry):
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__': main()
