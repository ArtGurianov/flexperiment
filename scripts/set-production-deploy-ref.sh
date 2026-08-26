#!/usr/bin/env bash
set -euo pipefail

expected_source_commit="${1:?Pass the expected 40-character source commit.}"
[[ "$expected_source_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected source commit must be a 40-character SHA." >&2; exit 2; }

# A deployment candidate must remain reachable from the protected source branch.
# This accepts a paused owner replay after main advances, but rejects unadvertised
# objects and ref rewrites.
git fetch --no-tags origin main
git cat-file -e "$expected_source_commit^{commit}" || { echo "Deployment source commit is unavailable locally." >&2; exit 1; }
git merge-base --is-ancestor "$expected_source_commit" origin/main || { echo "Deployment source commit is not reachable from origin/main." >&2; exit 1; }

git push origin "$expected_source_commit:refs/heads/production-deploy"
configured_deploy_ref="$(git ls-remote origin refs/heads/production-deploy | awk 'NR == 1 { print $1 }')"
[[ "$configured_deploy_ref" == "$expected_source_commit" ]] || {
  echo "production-deploy did not resolve to the expected source commit." >&2
  exit 1
}
