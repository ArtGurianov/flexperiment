#!/usr/bin/env bash
set -euo pipefail

expected_source_commit="${1:?Pass the expected 40-character source commit.}"
[[ "$expected_source_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected source commit must be a 40-character SHA." >&2; exit 2; }
source_ref="${CONTROLLED_DEPLOY_SOURCE_REF:-main}"
[[ "$source_ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] || { echo "Deployment source ref is invalid." >&2; exit 2; }

# A deployment candidate must remain reachable from the protected source branch.
# A same-owner repair may use its explicitly dispatched recovery branch. The
# workflow verifies that branch before setting this override; all normal
# callers remain pinned to main.
git fetch --no-tags origin "$source_ref"
git cat-file -e "$expected_source_commit^{commit}" || { echo "Deployment source commit is unavailable locally." >&2; exit 1; }
git merge-base --is-ancestor "$expected_source_commit" "origin/$source_ref" || { echo "Deployment source commit is not reachable from origin/$source_ref." >&2; exit 1; }

git push origin "$expected_source_commit:refs/heads/production-deploy"
configured_deploy_ref="$(git ls-remote origin refs/heads/production-deploy | awk 'NR == 1 { print $1 }')"
[[ "$configured_deploy_ref" == "$expected_source_commit" ]] || {
  echo "production-deploy did not resolve to the expected source commit." >&2
  exit 1
}
