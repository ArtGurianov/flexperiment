#!/usr/bin/env bash
set -euo pipefail

expected_source_commit="${1:?Pass the expected 40-character source commit.}"
[[ "$expected_source_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected source commit must be a 40-character SHA." >&2; exit 2; }
# Optional: a directory to capture each webhook's response body text into,
# for later forensic/observability review. Never parsed or acted on by this
# script itself - see "Coolify webhook acceptance is not deployment
# convergence" in docs/release/DEPLOYMENT_INVARIANTS.md for why a caller must
# not treat these responses as proof of anything beyond enqueue acceptance.
# "Response body text", not "raw response body": command substitution strips
# trailing newlines and cannot represent NUL bytes, so this is not a
# byte-exact capture - that has never mattered for the small textual/JSON
# content Coolify is expected to return, and this script does not attempt a
# binary-safe capture.
# It is diagnostic-only in a stronger sense too: a failure to persist a
# captured response (disk full, permission error, bad path) must never
# change whether a webhook is considered accepted, and must never prevent a
# later webhook in this same run from firing - only the real Coolify request
# result may do either of those. And when no capture directory is given at
# all, this script must behave exactly as it did before capture support
# existed - it must not buffer response bodies or change what reaches
# stdout/stderr just because the *capability* to capture exists.
response_capture_dir="${2:-}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN is required.}"
: "${COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL:?COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL is required.}"
: "${COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL:?COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL is required.}"
: "${COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL:?COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL is required.}"

configured_deploy_ref="$(git ls-remote origin refs/heads/production-deploy | awk 'NR == 1 { print $1 }')"
[[ "$configured_deploy_ref" == "$expected_source_commit" ]] || {
  echo "Configured production ref does not match the expected source commit." >&2
  exit 1
}

# Captured response files may contain undocumented Coolify response content
# (its shape has never been verified against this repo's own security
# review) - keep them private to whoever runs this script.
umask 077

if [[ -n "$response_capture_dir" ]]; then
  mkdir -p "$response_capture_dir" || echo "Warning: could not create Coolify response capture directory ${response_capture_dir}." >&2
fi

deploy() {
  local name="$1" url="$2"
  case "$name" in
    commerce | frontend | admin) ;;
    *) echo "Internal error: unknown Coolify deployment target name '${name}'." >&2; return 1 ;;
  esac
  if [[ -z "$response_capture_dir" ]]; then
    # Exactly the original, pre-capture-support behavior: both streams
    # discarded, nothing buffered, nothing new reaches this script's own
    # stdout/stderr. Introducing the capture capability must not change this
    # path at all for the ordinary case where nobody asked for it.
    curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 30 \
      -H "Authorization: Bearer $COOLIFY_TOKEN" -X POST "$url" >/dev/null 2>&1 \
      || { echo "A Coolify deployment webhook rejected a request." >&2; return 1; }
    return 0
  fi
  # The webhook request's own success/failure is the only thing that decides
  # whether this deployment target was accepted - captured separately from,
  # and never entangled with, persisting its response body text below. curl's
  # own stderr is discarded here too: the generic message below already
  # tells the operator the webhook failed, and the response body text
  # (captured on both success and failure) is retained in the private
  # diagnostic file instead of being echoed into the run's own logs.
  local body="" request_status=0
  body="$(curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -X POST "$url" 2>/dev/null)" || request_status=$?
  printf '%s' "$body" > "${response_capture_dir}/coolify-response-${name}.json" \
    || echo "Warning: could not persist the Coolify response for ${name}." >&2
  if [[ "$request_status" -ne 0 ]]; then
    echo "A Coolify deployment webhook rejected a request." >&2
    return 1
  fi
}

# HTTP acceptance is only an enqueue acknowledgement. The workflow proves the
# deployed source afterwards from the Commerce, frontend and admin surfaces.
# The response body text itself (captured above when response_capture_dir is
# set) is never parsed by this script - it is not yet known whether
# Coolify's webhook response carries a stable deployment identifier that a
# future controller could poll directly instead of guessing a fixed
# settling delay.
deploy commerce "$COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL"
deploy frontend "$COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL"
deploy admin "$COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL"
