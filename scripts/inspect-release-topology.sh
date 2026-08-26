#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: inspect-release-topology.sh --candidate <sha-or-ref> --repair <sha-or-ref> --controller <sha-or-ref> --promotion <sha-or-ref>

Inspects locally available Git objects only. It never fetches, checks out, or
mutates refs.
EOF
}

candidate_input=""
repair_input=""
controller_input=""
promotion_input=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate) candidate_input="${2:-}"; shift 2 ;;
    --repair) repair_input="${2:-}"; shift 2 ;;
    --controller) controller_input="${2:-}"; shift 2 ;;
    --promotion) promotion_input="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "RELEASE_TOPOLOGY_INVALID_ARGUMENT" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$candidate_input" && -n "$repair_input" && -n "$controller_input" && -n "$promotion_input" ]] || {
  echo "RELEASE_TOPOLOGY_IDENTITIES_REQUIRED" >&2
  usage
  exit 2
}

resolve_commit() {
  local value="$1" label="$2" resolved
  resolved="$(git rev-parse --verify --quiet "${value}^{commit}" 2>/dev/null)" || {
    echo "RELEASE_TOPOLOGY_${label}_COMMIT_UNAVAILABLE" >&2
    return 1
  }
  [[ "$resolved" =~ ^[0-9a-f]{40}$ ]] || {
    echo "RELEASE_TOPOLOGY_${label}_COMMIT_INVALID" >&2
    return 1
  }
  printf '%s\n' "$resolved"
}

is_ancestor() {
  git merge-base --is-ancestor "$1" "$2" 2>/dev/null && printf true || printf false
}

candidate="$(resolve_commit "$candidate_input" CANDIDATE)" || exit 1
repair="$(resolve_commit "$repair_input" REPAIR)" || exit 1
controller="$(resolve_commit "$controller_input" CONTROLLER)" || exit 1
promotion="$(resolve_commit "$promotion_input" PROMOTION)" || exit 1

candidate_is_ancestor_of_repair="$(is_ancestor "$candidate" "$repair")"
[[ "$candidate_is_ancestor_of_repair" == true ]] || {
  echo "RELEASE_TOPOLOGY_CANDIDATE_NOT_ANCESTOR_OF_REPAIR" >&2
  exit 1
}

parent_line="$(git rev-list --parents -n 1 "$promotion")"
read -r -a parent_parts <<<"$parent_line"
[[ "${#parent_parts[@]}" == 2 ]] || {
  echo "RELEASE_TOPOLOGY_PROMOTION_PARENT_COUNT_INVALID" >&2
  exit 1
}
promotion_parent="${parent_parts[1]}"
promotion_parent_is_exact_repair=false
if [[ "$promotion_parent" == "$repair" ]]; then promotion_parent_is_exact_repair=true; fi
[[ "$promotion_parent_is_exact_repair" == true ]] || {
  echo "RELEASE_TOPOLOGY_PROMOTION_PARENT_INVALID" >&2
  exit 1
}

changed_paths_json="$(git diff --no-ext-diff --name-only "$repair..$promotion" | jq -Rsc 'split("\n") | map(select(length > 0))')"
repair_is_ancestor_of_controller="$(is_ancestor "$repair" "$controller")"
controller_is_ancestor_of_promotion="$(is_ancestor "$controller" "$promotion")"

jq -cn \
  --arg candidate "$candidate" \
  --arg repair "$repair" \
  --arg controller "$controller" \
  --arg promotion "$promotion" \
  --arg promotion_parent "$promotion_parent" \
  --argjson candidate_is_ancestor_of_repair "$candidate_is_ancestor_of_repair" \
  --argjson repair_is_ancestor_of_controller "$repair_is_ancestor_of_controller" \
  --argjson promotion_parent_is_exact_repair "$promotion_parent_is_exact_repair" \
  --argjson controller_is_ancestor_of_promotion "$controller_is_ancestor_of_promotion" \
  --argjson promotion_diff_paths "$changed_paths_json" '
  {
    candidate: $candidate,
    repair: $repair,
    controller: $controller,
    promotion: $promotion,
    candidate_is_ancestor_of_repair: $candidate_is_ancestor_of_repair,
    repair_is_ancestor_of_controller: $repair_is_ancestor_of_controller,
    promotion_parent: $promotion_parent,
    promotion_parent_is_exact_repair: $promotion_parent_is_exact_repair,
    controller_is_ancestor_of_promotion: $controller_is_ancestor_of_promotion,
    promotion_diff_paths: $promotion_diff_paths
  }
'
