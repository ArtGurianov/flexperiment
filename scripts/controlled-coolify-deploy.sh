#!/usr/bin/env bash
set -euo pipefail

expected_source_commit="${1:?Pass the expected 40-character source commit.}"
[[ "$expected_source_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected source commit must be a 40-character SHA." >&2; exit 2; }
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN is required.}"
: "${COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL:?COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL is required.}"
: "${COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL:?COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL is required.}"
: "${COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL:?COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL is required.}"

configured_main="$(git ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
[[ "$configured_main" == "$expected_source_commit" ]] || {
  echo "Configured production ref does not match the expected source commit." >&2
  exit 1
}

deploy() {
  curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -X POST "$1" >/dev/null 2>&1 \
    || { echo "A Coolify deployment webhook rejected a request." >&2; return 1; }
}

# HTTP acceptance is only an enqueue acknowledgement. The workflow proves the
# deployed source afterwards from the Commerce, frontend and admin surfaces.
deploy "$COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL"
deploy "$COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL"
deploy "$COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL"
