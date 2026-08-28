#!/usr/bin/env bash
set -euo pipefail

# Next.js App Router's static export emits, for every nested route, both a
# `<route>.html` page and a same-named `<route>/` directory holding only RSC
# prefetch payloads (no index.html). This proves try_files resolves the real
# page instead of short-circuiting on that empty sibling directory.
config_path="$PWD/deploy/frontend.nginx.conf"

docker run --rm \
  -v "$config_path:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.29-alpine nginx -t

fixture_dir="$(mktemp -d)"
response_file="$(mktemp)"
container_name="flexperiment-frontend-nginx-routing-smoke-$$"
host_port=$((20000 + RANDOM % 20000))

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir" "$response_file"
}
trap cleanup EXIT INT TERM

mkdir -p "$fixture_dir/payment/success" "$fixture_dir/legal/public-offer" "$fixture_dir/refund/confirm" "$fixture_dir/ticket" "$fixture_dir/_next/static/chunks"
echo "ROOT_PAGE" > "$fixture_dir/index.html"
echo "PAYMENT_SUCCESS_PAGE" > "$fixture_dir/payment/success.html"
echo "rsc-tree-payload" > "$fixture_dir/payment/success/__next._tree.txt"
echo "LEGAL_PUBLIC_OFFER_PAGE" > "$fixture_dir/legal/public-offer.html"
echo "rsc-tree-payload" > "$fixture_dir/legal/public-offer/__next._tree.txt"
echo "REFUND_CONFIRM_PAGE" > "$fixture_dir/refund/confirm.html"
echo "rsc-tree-payload" > "$fixture_dir/refund/confirm/__next._tree.txt"
echo "TICKET_PAGE" > "$fixture_dir/ticket.html"
echo "rsc-tree-payload" > "$fixture_dir/ticket/__next._tree.txt"
echo "console.log('asset')" > "$fixture_dir/_next/static/chunks/app-abc123.js"

# mktemp -d creates 0700 owned by the invoking uid. nginx workers run as uid
# 101, so on Linux every fixture read is denied and the whole contract fails as
# 403 while /healthz - served from config, not the mount - still answers 200.
# Docker Desktop on macOS masks bind-mount ownership, which is why this only
# ever failed on CI.
chmod -R a+rX "$fixture_dir"

docker run -d --name "$container_name" \
  -p "127.0.0.1:$host_port:80" \
  -v "$fixture_dir:/usr/share/nginx/html:ro" \
  -v "$config_path:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.29-alpine >/dev/null

base="http://127.0.0.1:$host_port"
ready=0
for _ in $(seq 1 40); do
  curl --silent --fail --output /dev/null "$base/healthz" && { ready=1; break; }
  sleep 0.25
done
[[ "$ready" == 1 ]] || { echo "nginx never became ready on $base/healthz" >&2; docker logs "$container_name" >&2 || true; exit 1; }

assert_body() {
  # -L: real clients (browsers, the payment provider's redirect target)
  # follow the 301 that normalizes away a trailing slash.
  # Deliberately not --fail: an HTTP error must be reported as a status, not
  # collapsed into curl's bare exit 22 by set -e.
  local path="$1" expected="$2" actual status
  status="$(curl --silent --location --output "$response_file" --write-out '%{http_code}' "$base$path")"
  actual="$(cat "$response_file")"
  [[ "$status" == "200" ]] || { echo "MISMATCH at $path: HTTP $status, expected 200" >&2; docker logs --tail 20 "$container_name" >&2 || true; exit 1; }
  [[ "$actual" == "$expected" ]] || { echo "MISMATCH at $path: got '$actual', expected '$expected'" >&2; exit 1; }
}

assert_status() {
  local path="$1" expected="$2" actual
  actual="$(curl --silent --location --output /dev/null --write-out '%{http_code}' "$base$path")"
  [[ "$actual" == "$expected" ]] || { echo "MISMATCH at $path: got HTTP $actual, expected $expected" >&2; exit 1; }
}

assert_body "/" "ROOT_PAGE"
assert_body "/payment/success/" "PAYMENT_SUCCESS_PAGE"
assert_body "/payment/success/?order=abc123" "PAYMENT_SUCCESS_PAGE"
assert_body "/legal/public-offer/" "LEGAL_PUBLIC_OFFER_PAGE"
assert_body "/refund/confirm/" "REFUND_CONFIRM_PAGE"
assert_body "/ticket/" "TICKET_PAGE"
assert_body "/_next/static/chunks/app-abc123.js" "console.log('asset')"
# The RSC-payload sibling directory must remain reachable for its own literal
# files; only the bare directory request must resolve to the page instead.
assert_body "/payment/success/__next._tree.txt" "rsc-tree-payload"
assert_status "/nonexistent/" "404"

# The trailing-slash normalization must be an explicit redirect, not a
# same-response rewrite, and it must preserve the query string.
redirect_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$base/payment/success/?order=abc123")"
[[ "$redirect_status" == "301" ]] || { echo "MISMATCH: expected 301 for trailing-slash request, got $redirect_status" >&2; exit 1; }
redirect_location="$(curl --silent --output /dev/null --write-out '%header{location}' "$base/payment/success/?order=abc123")"
[[ "$redirect_location" == "/payment/success?order=abc123" ]] || { echo "MISMATCH: expected relative redirect to /payment/success?order=abc123, got '$redirect_location'" >&2; exit 1; }

echo "Frontend nginx static-export routing: OK"
