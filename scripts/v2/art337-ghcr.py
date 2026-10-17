#!/usr/bin/env python3
"""Approved registry preparation only; no deployment or erasure admission."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

SOURCE = '08523bdf38eeddf5e745ce04d05e1f980a7ced93'
PACKAGES = {s: 'flexperiment-' + s for s in ('commerce-v2', 'platform-v2', 'admin-v2')}


def refuse(code):
    raise ValueError(code)


def api(path, absent=False):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            refuse('GITHUB_REDIRECT_REFUSED')
    request = urllib.request.Request('https://api.github.com/' + path, method='GET',
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if absent and error.code == 404:
            return None
        refuse('GITHUB_GET_REFUSED_' + str(error.code))


def run(args):
    return subprocess.check_output(args, timeout=300)


def package(service, absent=False):
    result = api('users/ArtGurianov/packages/container/' + PACKAGES[service], absent)
    if result is not None:
        print(json.dumps({'observedPackage': {k: result.get(k) for k in ('id', 'name', 'visibility')}}))
    if result is not None and (result.get('visibility') != 'private'
                              or result.get('name') != PACKAGES[service]):
        refuse('PACKAGE_VISIBILITY_OR_NAME_REFUSED')
    return result


def admit(service):
    if os.environ['GITHUB_REPOSITORY'] != 'ArtGurianov/flexperiment-artifacts' \
            or os.environ['GITHUB_REF'] != 'refs/heads/main' \
            or run(['git', '-C', 'deployment-source', 'rev-parse', 'HEAD']).decode().strip() != SOURCE \
            or run(['git', '-C', 'deployment-source', 'status', '--porcelain']).strip():
        refuse('PUBLISH_SCOPE_OR_SOURCE_REFUSED')
    if api('repos/ArtGurianov/flexperiment/git/ref/heads/main')['object']['sha'] != SOURCE:
        refuse('MAIN_SOURCE_DRIFT')
    checks = api('repos/ArtGurianov/flexperiment/commits/' + SOURCE + '/check-runs?per_page=100')['check_runs']
    for name in ('test', 'docker-build'):
        named = [c for c in checks if c['name'] == name and c['head_sha'] == SOURCE
                 and c.get('app', {}).get('slug') == 'github-actions']
        latest = max(named, key=lambda c: c['id']) if named else None
        if not latest or latest['conclusion'] != 'success':
            refuse('EXACT_SOURCE_CI_NOT_SUCCESS')
    if api('repos/ArtGurianov/flexperiment-artifacts').get('private') is not True:
        refuse('PRIVATE_PUBLISHER_REQUIRED')
    package(service, absent=True)
    print('PRIVATE_REGISTRY_PREPARATION_ADMITTED')


def verify(service):
    p = package(service)
    if p.get('repository', {}).get('full_name') != 'ArtGurianov/flexperiment-artifacts':
        refuse('PACKAGE_REPOSITORY_BINDING_REFUSED')
    digest = os.environ['ART337_DIGEST']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        refuse('MANIFEST_DIGEST_REQUIRED')
    reference = os.environ['ART337_REPOSITORY'] + '@' + digest
    raw = run(['docker', 'buildx', 'imagetools', 'inspect', reference, '--raw'])
    manifest = json.loads(raw)
    if 'sha256:' + hashlib.sha256(raw).hexdigest() != digest or 'manifests' in manifest \
            or manifest.get('schemaVersion') != 2 or not manifest.get('layers'):
        refuse('SINGLE_PLATFORM_MANIFEST_REQUIRED')
    run(['docker', 'pull', '--platform', 'linux/amd64', reference])
    image = json.loads(run(['docker', 'image', 'inspect', reference]))[0]
    if image['Id'] != manifest['config']['digest'] or image['Os'] != 'linux' \
            or image['Architecture'] != 'amd64' \
            or len(image['RootFS']['Layers']) != len(manifest['layers']):
        refuse('IMAGE_CONTENT_OR_PLATFORM_DRIFT')
    identity_path = '/usr/share/nginx/html/release.json' if service == 'admin-v2' else '/app/.identity/identity.json'
    native = json.loads(run(['docker', 'run', '--rm', '--read-only', '--network', 'none',
                            '--platform', 'linux/amd64', '--entrypoint', 'cat', image['Id'], identity_path]))
    if service == 'admin-v2':
        contract = json.loads(Path('deployment-source/release-surface-contract.json').read_bytes())
        expected = {'source_commit': SOURCE, 'admin_contract_version': contract['admin_contract_version']}
    else:
        expected = {'schema': 'flexperiment.build-identity/1', 'service': service.removesuffix('-v2')
                    if service == 'platform-v2' else service, 'sourceCommit': SOURCE}
    if native != expected:
        refuse('NATIVE_BAKED_IDENTITY_DRIFT')
    directory = Path('artifact-evidence'); directory.mkdir(mode=0o700)
    (directory/'manifest.json').write_bytes(raw)
    archive = directory/'image.docker.tar.gz'
    process = subprocess.Popen(['docker', 'save', reference], stdout=subprocess.PIPE)
    with gzip.open(archive, 'wb', compresslevel=1) as target:
        while chunk := process.stdout.read(1024 * 1024):
            target.write(chunk)
    if process.wait() != 0:
        refuse('IMAGE_ARCHIVE_FAILED')
    hasher = hashlib.sha256()
    with archive.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            hasher.update(chunk)
    recipient = os.environ['ART337_ARCHIVE_RECIPIENT']
    if not re.fullmatch(r'age1[0-9a-z]{58}', recipient):
        refuse('ARCHIVE_RECIPIENT_REQUIRED')
    encrypted = archive.with_name(archive.name + '.age')
    run(['age', '--recipient', recipient, '--output', str(encrypted), str(archive)])
    archive_size = archive.stat().st_size
    encrypted_hash = hashlib.sha256()
    with encrypted.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            encrypted_hash.update(chunk)
    archive.unlink()
    report = {'state': 'PRIVATE_GHCR_ARTIFACT_PUBLISHED_NOT_DEPLOYED', 'service': service,
              'sourceCommit': SOURCE, 'publisherCommit': os.environ['GITHUB_SHA'],
              'runId': os.environ['GITHUB_RUN_ID'], 'reference': reference,
              'manifestDigest': digest, 'manifest': manifest, 'imageId': image['Id'],
              'rootfs': image['RootFS']['Layers'], 'os': image['Os'],
              'architecture': image['Architecture'], 'nativeIdentityPath': identity_path,
              'nativeIdentity': native, 'packageId': p['id'], 'visibility': p['visibility'],
              'repository': p['repository']['full_name'], 'archiveSha256': hasher.hexdigest(),
              'archiveSize': archive_size, 'encryptedArchiveSha256': encrypted_hash.hexdigest(),
              'encryptedArchiveSize': encrypted.stat().st_size, 'archiveRecipient': recipient,
              'tag': os.environ['ART337_TAG'],
              'liveExecution': 'NOT_PERFORMED', 'restoreAdmission': 'NOT_QUALIFIED'}
    (directory/'artifact.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ('state', 'reference', 'imageId', 'visibility', 'archiveSha256')}))


if __name__ == '__main__':
    os.umask(0o077)
    service = os.environ['ART337_SERVICE']
    if service not in PACKAGES or os.environ['ART337_SOURCE'] != SOURCE \
            or os.environ['ART337_REPOSITORY'] != 'ghcr.io/artgurianov/' + PACKAGES[service]:
        refuse('APPROVED_REPOSITORY_REQUIRED')
    if sys.argv[1:] == ['admit']:
        admit(service)
    elif sys.argv[1:] == ['verify']:
        verify(service)
    else:
        refuse('REGISTRY_OPERATION_REFUSED')
