#!/usr/bin/env python3
"""Check the reviewed SOL documentation package, never runtime/transport/provider E2E."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--refref-repo', type=Path,
                    help='Optional local Refref Git repository for exact pinned blob verification; no fetch')
args = parser.parse_args()
failures = []
counts = {}


def require(ok, message):
    if not ok:
        failures.append(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *words):
    return subprocess.check_output(['git', '-C', str(repo), *words], stderr=subprocess.PIPE)


def source_files(section, repo):
    commit = section['commit']
    require(bool(re.fullmatch('[a-f0-9]{40}', commit)), 'Invalid exact source commit')
    names = [item['path'] for item in section['files']]
    require(len(names) == len(set(names)), 'Duplicate pinned source path')
    for item in section['files']:
        require(bool(re.fullmatch('[a-f0-9]{64}', item['sha256'])), 'Invalid source SHA-256')
        require(item['url'] == f"https://github.com/{section['repository']}/blob/{commit}/{item['path']}",
                'Source URL differs from pinned identity')
        require(not Path(item['path']).is_absolute() and '..' not in Path(item['path']).parts,
                'Invalid pinned relative path')
        if repo is not None:
            try:
                data = git(repo, 'show', commit + ':' + item['path'])
                require(sha(data) == item['sha256'], 'Pinned source bytes changed: ' + item['path'])
            except subprocess.CalledProcessError:
                require(False, 'Pinned Git blob unavailable: ' + item['path'])
    return len(names)


baseline = json.loads((BASE / 'source-baseline.json').read_text())
counts['verified_flexperiment_blobs'] = source_files(baseline['flexperiment'], REPO)
counts['refref_manifest_entries'] = source_files(baseline['refref'], args.refref_repo)
counts['verified_refref_blobs'] = counts['refref_manifest_entries'] if args.refref_repo else 0
require(baseline['independence']['otherAgentMaterialsRead'] is False and
        baseline['independence']['otherAgentBranchesRead'] is False, 'Initial independent preparation scope changed')
require(baseline['reviewProvenance']['comparisonAuthorized'] is True and
        baseline['reviewProvenance']['otherAgentMaterialsReadAfterAuthorization'] is True,
        'Post-comparison revision provenance missing')
require(baseline['verificationScope']['transportE2E'] == 'NOT_RUN' and
        baseline['verificationScope']['providerEvidenceE2E'] == 'NOT_RUN', 'Design claims runtime proof')

source = baseline['flexperiment']['commit']
lock = json.loads(git(REPO, 'show', source + ':commerce-v2/migrations/migration.lock'))
sql_paths = ['commerce-v2/migrations/' + name for name in lock['migrations']]
tree_sql = git(REPO, 'ls-tree', '-r', '--name-only', source, 'commerce-v2/migrations').decode().splitlines()
require(sql_paths == sorted(path for path in tree_sql if path.endswith('.sql')),
        'Pinned SQL files and ordered lock differ')
require(len(sql_paths) == baseline['flexperiment']['migrationCount'] == 35,
        'Unexpected baseline migration count; refresh source audit explicitly')
source_by_path = {entry['path']: entry for entry in baseline['flexperiment']['files']}
for path, digest in zip(sql_paths, lock['migrations'].values()):
    require(source_by_path.get(path, {}).get('sha256') == digest, 'SQL/lock baseline hash differs: ' + path)
counts['verified_migration_sql'] = len(sql_paths)

manifest = json.loads((BASE / 'package-manifest.json').read_text())
actual = {p.relative_to(BASE).as_posix() for p in BASE.rglob('*')
          if p.is_file() and p.name != 'package-manifest.json' and '__pycache__' not in p.parts}
declared = [entry['path'] for entry in manifest['files']]
require(len(declared) == len(set(declared)) == manifest['artifactCount'], 'Duplicate/missing package artifacts')
require(actual == set(declared), 'Package manifest file inventory differs')
for entry in manifest['files']:
    path = BASE / entry['path']
    require(path.is_file() and sha(path.read_bytes()) == entry['sha256'], 'Package hash differs: ' + entry['path'])
counts['verified_package_artifacts'] = len(declared)


def slugs(text):
    headings = re.findall(r'^#+\s+(.+)$', text, re.M)
    return {re.sub(r'[^\w\- ]', '', title.lower()).replace(' ', '-') for title in headings}


links = anchors = 0
for path in BASE.glob('*.md'):
    text = path.read_text()
    require(not re.search(r'/Users/|/private/tmp/|file_id=|libfile_', text),
            'Nonportable local/private attachment URL: ' + path.name)
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', text):
        url = urlsplit(target)
        if url.scheme:
            continue
        dest = (path.parent / unquote(url.path)).resolve() if url.path else path
        require(dest.is_relative_to(REPO), 'Local link escapes repository: ' + target)
        require(dest.exists(), 'Local link unavailable: ' + target)
        if dest.is_file() and dest.suffix == '.md' and url.fragment:
            require(unquote(url.fragment) in slugs(dest.read_text()), 'Markdown anchor unavailable: ' + target)
            anchors += 1
        links += 1
counts['local_links'] = links
counts['local_anchors'] = anchors

scenarios = (BASE / '06-migration-and-e2e.md').read_text()
ids = re.findall(r'^\| (FX10-(?:COM|LMS|LAB|RES)-\d{3}) \|', scenarios, re.M)
expected = manifest['plannedAcceptanceCaseIds']
require(len(ids) == len(set(ids)) == len(expected) and set(ids) == set(expected), 'Acceptance case identities differ')
require(len(ids) == 80, 'Acceptance count changed without explicit review')
for group, size in [('COM', 38), ('LMS', 12), ('LAB', 17), ('RES', 13)]:
    require({item for item in ids if item.startswith('FX10-' + group + '-')} ==
            {f'FX10-{group}-{number:03d}' for number in range(1, size + 1)},
            'Acceptance group has a missing or unexpected identity: ' + group)
counts['planned_acceptance_cases'] = len(ids)

if args.refref_repo:
    # Verify pinned GitHub file/heading targets against local Git bytes, not a live browser.
    external_links = 0
    prefix = '/ArtGurianov/refref/blob/' + baseline['refref']['commit'] + '/'
    for path in BASE.glob('*.md'):
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', path.read_text()):
            url = urlsplit(target)
            if url.netloc != 'github.com' or not url.path.startswith(prefix):
                continue
            source_path = unquote(url.path[len(prefix):])
            try:
                content = git(args.refref_repo, 'show', baseline['refref']['commit'] + ':' + source_path).decode()
                if url.fragment and not re.fullmatch(r'L\d+(?:-L\d+)?', url.fragment):
                    require(unquote(url.fragment) in slugs(content), 'Pinned Refref anchor unavailable: ' + target)
            except subprocess.CalledProcessError:
                require(False, 'Pinned Refref link unavailable: ' + target)
            external_links += 1
    counts['verified_pinned_refref_links'] = external_links

print(json.dumps({'status': 'FAIL' if failures else 'PASS', 'scope': 'SOL_DOCUMENTATION_PACKAGE_ONLY',
                  'flexperiment_commit': source, 'refref_commit': baseline['refref']['commit'],
                  'counts': counts, 'failures': failures,
                  'external_refref_bytes': 'VERIFIED' if args.refref_repo else 'NOT_REQUESTED_METADATA_ONLY',
                  'implementation_source_contract': 'NOT_RUN', 'transport_e2e': 'NOT_RUN',
                  'provider_evidence_e2e': 'NOT_RUN'}, ensure_ascii=False, indent=2))
sys.exit(bool(failures))
