#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: inspect-runtime-candidate-topology.sh --production-deploy <sha-or-ref> --candidate <sha-or-ref>

Inspects locally available Git objects only. It never fetches, checks out, or
mutates refs. It reports facts only; it does not authorize a deployment or
emit a recommended action.
EOF
}

production_deploy_input=""
candidate_input=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --production-deploy) production_deploy_input="${2:-}"; shift 2 ;;
    --candidate) candidate_input="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "RUNTIME_CANDIDATE_TOPOLOGY_INVALID_ARGUMENT" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$production_deploy_input" && -n "$candidate_input" ]] || {
  echo "RUNTIME_CANDIDATE_TOPOLOGY_IDENTITIES_REQUIRED" >&2
  usage
  exit 2
}

resolve_commit() {
  local value="$1" label="$2" resolved
  resolved="$(git rev-parse --verify --quiet "${value}^{commit}" 2>/dev/null)" || {
    echo "RUNTIME_CANDIDATE_TOPOLOGY_${label}_COMMIT_UNAVAILABLE" >&2
    return 1
  }
  [[ "$resolved" =~ ^[0-9a-f]{40}$ ]] || {
    echo "RUNTIME_CANDIDATE_TOPOLOGY_${label}_COMMIT_INVALID" >&2
    return 1
  }
  printf '%s\n' "$resolved"
}

is_ancestor() {
  git merge-base --is-ancestor "$1" "$2" 2>/dev/null && printf true || printf false
}

production_deploy="$(resolve_commit "$production_deploy_input" PRODUCTION_DEPLOY)" || exit 1
candidate="$(resolve_commit "$candidate_input" CANDIDATE)" || exit 1

candidate_is_descendant="$(is_ancestor "$production_deploy" "$candidate")"

# Every maintenance/audit commit carries .release/maintenance-only in its own
# tree, and that presence persists forward into any descendant that does not
# explicitly remove it - see "Runtime candidates and maintenance commits are
# different artifact classes" in docs/release/DEPLOYMENT_INVARIANTS.md. This
# walks the exact candidate ancestry path and reports every commit in range
# that carries the marker, rather than checking only the candidate's own tip.
maintenance_commits_json="[]"
merge_commits_json="[]"
if [[ "$candidate_is_descendant" == true && "$production_deploy" != "$candidate" ]]; then
  maintenance_commits_json="$(
    git rev-list --ancestry-path "${production_deploy}..${candidate}" | while IFS= read -r commit; do
      if git cat-file -e "${commit}:.release/maintenance-only" 2>/dev/null; then printf '%s\n' "$commit"; fi
    done | jq -Rsc 'split("\n") | map(select(length > 0))'
  )"
  # An ordinary runtime candidate is a strictly linear chain from
  # production-deploy: any merge commit in range means some other lineage
  # (which may not itself carry the maintenance-only marker) entered runtime
  # history. Recovery workflows waive this rule under their own authority.
  merge_commits_json="$(
    git rev-list --min-parents=2 --ancestry-path "${production_deploy}..${candidate}" | jq -Rsc 'split("\n") | map(select(length > 0))'
  )"
fi

jq -cn \
  --arg production_deploy "$production_deploy" \
  --arg candidate "$candidate" \
  --argjson candidate_is_descendant_of_production_deploy "$candidate_is_descendant" \
  --argjson maintenance_commits_in_range "$maintenance_commits_json" \
  --argjson merge_commits_in_range "$merge_commits_json" '
  {
    production_deploy: $production_deploy,
    candidate: $candidate,
    candidate_is_descendant_of_production_deploy: $candidate_is_descendant_of_production_deploy,
    maintenance_commits_in_range: $maintenance_commits_in_range,
    merge_commits_in_range: $merge_commits_in_range
  }
'
