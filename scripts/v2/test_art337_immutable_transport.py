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
import shlex
from unittest.mock import Mock, patch
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import art337_immutable_recovery as r
from coolify446_pipeline import replay


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
    network = 'art337-network-' + token
    temporary = tempfile.TemporaryDirectory(prefix='art337-compose-')
    workdir = Path(temporary.name)
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
        # Route the real create_delivery request through the captured installed
        # API normalization and job methods. Only persistence/topology/custody
        # are fixtures; the parser/image selection/Compose/pull-up code is real.
        command(['docker', 'network', 'create', '--internal', network])
        original = {'uuid': r.ORIGINAL_APP, 'environment_id': 6, 'destination_id': 0,
            'environment': {'name': 'canary-v2', 'uuid': 'v'*24,
                            'project': {'uuid': 'wclu2wovf4ctpbgam3h7grzb'}},
            'destination': {'uuid': '5gwzwaau6dfwx3xrqgahstzi',
                            'server': {'uuid': '1460ru9bxuxzrqnswauxqxhc'}}}
        new_uuid = token[:24]
        pipeline = None
        created = None
        def api(method, path, body=None):
            nonlocal pipeline, created
            if method == 'POST' and path == '/applications/dockerimage':
                pipeline = replay(body, {'containerName': container, 'workdir': str(workdir),
                                         'uuid': new_uuid, 'network': network})
                created = {'uuid': new_uuid, 'environment_id': 6, 'destination_id': 0,
                    'build_pack': 'dockerimage', 'name': body['name'],
                    'settings': {'is_auto_deploy_enabled': False, 'is_preview_deployments_enabled': False},
                    **pipeline['persisted']}
                return {'uuid': new_uuid}
            if method == 'GET': return original if path.endswith(r.ORIGINAL_APP) else created
            raise RuntimeError('UNEXPECTED_FIXTURE_API_CALL')
        rpc = Mock(); rpc.api.side_effect = api; rpc.container.return_value = None
        rpc.exclusive_canary.return_value = {'exclusive': True}
        with patch.object(r, 'verify_parent'), patch.object(r.q, 'verify_payload_stopped'), \
                patch.object(r, 'once', side_effect=lambda name, request, action: action()):
            r.create_delivery(expected, rpc)
        if pipeline['job']['productionImage'] != reference:
            raise RuntimeError('COOLIFY_JOB_RESOLVED_MUTABLE_REFERENCE')
        compose = pipeline['job']['compose']
        service = compose['services'][container]
        if service['image'] != reference or 'build' in service:
            raise RuntimeError('COOLIFY_COMPOSE_IMAGE_DRIFT')
        # The runtime command is intentionally an inert Node fixture. The image
        # field and pull/up commands are unchanged from upstream source replay.
        service.update(entrypoint=['node'], command=['-e', 'setInterval(()=>{},1000)'], read_only=True)
        (workdir/'compose.yaml').write_text(json.dumps(compose))
        (workdir/'.env').write_text('')
        actual_commands = []
        for captured in pipeline['job']['commands']:
            argv = shlex.split(captured)
            command(argv)
            actual_commands.append(argv)
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
            'isolatedErasureContracts': 'PASS', 'coolifyVersion': pipeline['version'],
            'coolifySourceHashes': pipeline['sourceHashes'], 'coolifyPersistedResource': {
                key: pipeline['persisted'][key] for key in ('docker_registry_image_name','docker_registry_image_tag')},
            'coolifyProductionImage': pipeline['job']['productionImage'],
            'executedCoolifyCommands': actual_commands, 'liveExecution': 'NOT_PERFORMED'}, indent=2))
        print(json.dumps({'state': 'ISOLATED_IMMUTABLE_TRANSPORT_PASS', 'sourceCommit': r.TARGET,
                          'manifestDigest': digest, 'imageId': expected['imageId']}))
    finally:
        for name in (container, registry):
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        temporary.cleanup()


if __name__ == '__main__': main()
