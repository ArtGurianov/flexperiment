#!/usr/bin/env bash
set -euo pipefail

# Static assertion over the reference Caddyfile topology (Phase 9 round-2
# P1 fix): admin.flexperiment.ru and partner.flexperiment.ru must both
# reverse_proxy to the shared frontend container ("admin"), never straight
# to "commerce" - that would bypass deploy/admin.nginx.conf's own host-based
# routing boundary entirely and serve raw Commerce JSON in place of the
# frontend for every non-API request. A real `caddy validate` needs a
# running/fetchable Caddy binary this repo does not otherwise depend on;
# this script proves the one topology fact that actually matters instead.

caddyfile="$PWD/deploy/Caddyfile"

extract_block() {
  # Prints the body of the first "<host> { ... }" block matching $1.
  awk -v host="$1" '
    $0 ~ "^"host" \\{" { capturing = 1; next }
    capturing && /^}/ { capturing = 0 }
    capturing { print }
  ' "$caddyfile"
}

assert_block_proxies_to_admin() {
  local host="$1" block
  block="$(extract_block "$host")"
  if [[ -z "$block" ]]; then
    echo "MISMATCH: no $host { ... } block found in $caddyfile" >&2
    exit 1
  fi
  if ! grep -Eq 'reverse_proxy[[:space:]]+admin:[0-9]+' <<<"$block"; then
    echo "MISMATCH: $host does not reverse_proxy to the shared frontend container (admin:<port>)" >&2
    echo "--- block body ---" >&2
    echo "$block" >&2
    exit 1
  fi
  if grep -Eq 'reverse_proxy[[:space:]]+commerce:[0-9]+' <<<"$block"; then
    echo "MISMATCH: $host routes directly to commerce:<port> - this bypasses admin.nginx.conf's host-routing boundary entirely" >&2
    exit 1
  fi
}

assert_block_proxies_to_admin "admin.flexperiment.ru"
assert_block_proxies_to_admin "partner.flexperiment.ru"

# The two blocks must target the exact same upstream - "same frontend
# container" is the whole point of the Phase 9 shared-frontend topology.
admin_target="$(extract_block "admin.flexperiment.ru" | grep -Eo 'reverse_proxy[[:space:]]+[^[:space:]]+' | awk '{print $2}')"
partner_target="$(extract_block "partner.flexperiment.ru" | grep -Eo 'reverse_proxy[[:space:]]+[^[:space:]]+' | awk '{print $2}')"
if [[ "$admin_target" != "$partner_target" ]]; then
  echo "MISMATCH: admin.flexperiment.ru targets '$admin_target' but partner.flexperiment.ru targets '$partner_target' - both must route to the same frontend container" >&2
  exit 1
fi

echo "Caddyfile reference topology: admin + partner -> shared frontend container ($admin_target): OK"
