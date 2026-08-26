#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: verify-legal-promotion.sh <repair-sha-or-ref> <promotion-sha-or-ref>

Verifies locally available commits only. It never fetches, checks out, or
mutates refs.
EOF
}

[[ $# == 2 ]] || { usage; exit 2; }

resolve_commit() {
  local value="$1" label="$2" resolved
  resolved="$(git rev-parse --verify --quiet "${value}^{commit}" 2>/dev/null)" || {
    echo "LEGAL_PROMOTION_${label}_COMMIT_UNAVAILABLE" >&2
    return 1
  }
  [[ "$resolved" =~ ^[0-9a-f]{40}$ ]] || {
    echo "LEGAL_PROMOTION_${label}_COMMIT_INVALID" >&2
    return 1
  }
  printf '%s\n' "$resolved"
}

repair="$(resolve_commit "$1" REPAIR)" || exit 1
promotion="$(resolve_commit "$2" PROMOTION)" || exit 1
parent_line="$(git rev-list --parents -n 1 "$promotion")"
read -r -a parent_parts <<<"$parent_line"
[[ "${#parent_parts[@]}" == 2 ]] || {
  echo "LEGAL_PROMOTION_PARENT_COUNT_INVALID" >&2
  exit 1
}
promotion_parent="${parent_parts[1]}"
[[ "$promotion_parent" == "$repair" ]] || {
  echo "LEGAL_PROMOTION_PARENT_INVALID" >&2
  exit 1
}

changed_paths=()
while IFS= read -r changed_path; do
  [[ -n "$changed_path" ]] && changed_paths+=("$changed_path")
done < <(git diff --no-ext-diff --name-only "$repair..$promotion")
[[ "${#changed_paths[@]}" -gt 0 ]] || {
  echo "LEGAL_PROMOTION_SCOPE_EMPTY" >&2
  exit 1
}
for changed_path in "${changed_paths[@]}"; do
  case "$changed_path" in
    certification.sh|commerce/legal/production-manifest.json|public/legal/*) ;;
    *) echo "LEGAL_PROMOTION_SCOPE_INVALID" >&2; exit 1 ;;
  esac
done

changed_paths_json="$(printf '%s\n' "${changed_paths[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
jq -cn \
  --arg repair_sha "$repair" \
  --arg promotion_sha "$promotion" \
  --arg promotion_parent "$promotion_parent" \
  --argjson changed_paths "$changed_paths_json" '
  {
    repair_sha: $repair_sha,
    promotion_sha: $promotion_sha,
    promotion_parent: $promotion_parent,
    direct_child: true,
    allowed_scope: true,
    changed_paths: $changed_paths
  }
'
