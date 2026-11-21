#!/usr/bin/env bash
# Read-only V2 build-identity readout (G-11). Observation, never authority:
# it GETs each configured /identity URL, validates the baked
# flexperiment.build-identity/1 document and prints one line per surface.
# It changes nothing and always exits 0 for a reachable-or-not readout;
# only a malformed configuration exits non-zero.
#
# Usage: read-v2-identity.sh [EXPECTED_COMMIT]
# Env:   V2_COMMERCE_IDENTITY_URL, V2_PLATFORM_IDENTITY_URL, V2_ADMIN_IDENTITY_URL
#        (each optional; unset = "not configured")
#        V2_IDENTITY_FETCH (test hook: command that prints the body for URL $1)
set -euo pipefail

expected="${1:-}"
if [[ -n "$expected" && ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXPECTED_COMMIT_INVALID" >&2; exit 2
fi

fetch() {
  if [[ -n "${V2_IDENTITY_FETCH:-}" ]]; then "$V2_IDENTITY_FETCH" "$1"; return; fi
  curl --fail --silent --show-error --proto '=https' --max-redirs 0 \
    --connect-timeout 5 --max-time 15 -H 'Cache-Control: no-cache' "$1"
}

read_one() {
  local label="$1" service="$2" url="$3" body commit verdict
  if [[ -z "$url" ]]; then printf '%-9s %-40s %s\n' "$label" "-" "NOT_CONFIGURED"; return; fi
  if [[ ! "$url" =~ ^https://[a-z0-9.-]+\.flexperiment\.ru/identity$ ]]; then
    echo "IDENTITY_URL_INVALID:$label" >&2; exit 2
  fi
  if ! body="$(fetch "$url" 2>/dev/null)"; then
    printf '%-9s %-40s %s\n' "$label" "-" "UNREACHABLE"; return
  fi
  commit="$(jq -er --arg s "$service" '
      select(.schema == "flexperiment.build-identity/1" and .service == $s
             and (.sourceCommit | test("^[0-9a-f]{40}$"))) | .sourceCommit' <<<"$body" 2>/dev/null)" \
    || { printf '%-9s %-40s %s\n' "$label" "-" "IDENTITY_INVALID"; return; }
  verdict="OBSERVED"
  if [[ -n "$expected" ]]; then
    [[ "$commit" == "$expected" ]] && verdict="MATCHES_EXPECTED" || verdict="DIFFERS_FROM_EXPECTED"
  fi
  printf '%-9s %-40s %s\n' "$label" "$commit" "$verdict"
}

read_one commerce commerce-v2 "${V2_COMMERCE_IDENTITY_URL:-}"
read_one platform platform    "${V2_PLATFORM_IDENTITY_URL:-}"
read_one admin    admin-v2    "${V2_ADMIN_IDENTITY_URL:-}"
