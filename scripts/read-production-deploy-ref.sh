#!/usr/bin/env bash
set -euo pipefail

# Read-only. Prints the exact 40-character SHA currently at
# refs/heads/production-deploy on origin, or fails closed. Never fetches the
# commit itself, checks out, or mutates any ref.
remote_ref="refs/heads/production-deploy"

output="$(git ls-remote --exit-code origin "$remote_ref")" || {
  echo "PRODUCTION_DEPLOY_REMOTE_POINTER_INVALID" >&2
  exit 1
}
sha="$(printf '%s\n' "$output" | awk -v ref="$remote_ref" '
  NF != 2 || $2 != ref { invalid = 1; next }
  { count += 1; sha = $1 }
  END {
    if (invalid || count != 1) exit 1
    print sha
  }
')" || {
  echo "PRODUCTION_DEPLOY_REMOTE_POINTER_INVALID" >&2
  exit 1
}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || {
  echo "PRODUCTION_DEPLOY_REMOTE_POINTER_INVALID" >&2
  exit 1
}
printf '%s\n' "$sha"
