#!/usr/bin/env bash
set -euo pipefail

expected_source_commit="${1:?Pass the expected 40-character source commit.}"
expected_previous_source_commit="${2:-}"
[[ "$expected_source_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected source commit must be a 40-character SHA." >&2; exit 2; }
[[ -z "$expected_previous_source_commit" || "$expected_previous_source_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected previous source commit must be a 40-character SHA." >&2; exit 2; }
remote_ref="refs/heads/production-deploy"

# The calling controlled workflow authorizes the candidate before it pauses
# registrations. This ref is only a mutable deployment pointer, not source
# history, so its old tip must not constrain a new authorized target.
read_remote_pointer() {
  local output
  output="$(git ls-remote --exit-code origin "$remote_ref")" || return 1
  printf '%s\n' "$output" | awk -v ref="$remote_ref" '
    NF != 2 || $2 != ref { invalid = 1; next }
    { count += 1; sha = $1 }
    END {
      if (invalid || count != 1) exit 1
      print sha
    }
  '
}

if ! observed_remote_sha="$(read_remote_pointer)"; then
  echo "PRODUCTION_DEPLOY_REMOTE_POINTER_INVALID" >&2
  exit 1
fi
[[ "$observed_remote_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "PRODUCTION_DEPLOY_REMOTE_POINTER_INVALID" >&2
  exit 1
}
if [[ -n "$expected_previous_source_commit" && "$observed_remote_sha" != "$expected_previous_source_commit" ]]; then
  echo "PRODUCTION_DEPLOY_EXPECTED_PREVIOUS_POINTER_MISMATCH" >&2
  exit 1
fi
git cat-file -e "$expected_source_commit^{commit}" || { echo "Deployment source commit is unavailable locally." >&2; exit 1; }

# A maintenance/audit commit (a runtime candidate merged with one-shot bridge
# tooling for review) declares itself with this marker and must never become
# a deploy target: see "Runtime candidates and maintenance commits are
# different artifact classes" in docs/release/DEPLOYMENT_INVARIANTS.md.
if git cat-file -e "${expected_source_commit}:.release/maintenance-only" 2>/dev/null; then
  echo "PRODUCTION_DEPLOY_TARGET_IS_MAINTENANCE_ONLY" >&2
  exit 1
fi

if [[ "$observed_remote_sha" != "$expected_source_commit" ]]; then
  git push \
    "--force-with-lease=${remote_ref}:${observed_remote_sha}" \
    origin \
    "${expected_source_commit}:${remote_ref}"
fi

if ! actual_remote_sha="$(read_remote_pointer)"; then
  echo "PRODUCTION_DEPLOY_POINTER_POSTCONDITION_FAILED" >&2
  exit 1
fi
[[ "$actual_remote_sha" == "$expected_source_commit" ]] || {
  echo "PRODUCTION_DEPLOY_POINTER_POSTCONDITION_FAILED" >&2
  exit 1
}
