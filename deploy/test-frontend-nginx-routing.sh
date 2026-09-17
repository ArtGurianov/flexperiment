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
# The branded not-found export, the raw legal Markdown a legal release verifies
# over HTTPS, and robots.txt - which must NOT be caught by the .txt crawl-
# suppression location below.
echo "BRANDED_404_PAGE" > "$fixture_dir/404.html"
echo "# Публичная оферта" > "$fixture_dir/legal/public-offer.md"
printf 'User-Agent: *\nAllow: /\n' > "$fixture_dir/robots.txt"
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

# assert_body hard-pins status 200, so it cannot express "this 404 must carry
# the branded body" - which is the whole point of the error_page directive.
assert_status_and_body() {
  local path="$1" expected_status="$2" expected="$3" actual status
  status="$(curl --silent --location --output "$response_file" --write-out '%{http_code}' "$base$path")"
  actual="$(cat "$response_file")"
  [[ "$status" == "$expected_status" ]] || { echo "MISMATCH at $path: HTTP $status, expected $expected_status" >&2; exit 1; }
  [[ "$actual" == "$expected" ]] || { echo "MISMATCH at $path: got '$actual', expected '$expected'" >&2; exit 1; }
}

# Same --write-out '%header{...}' idiom the redirect assertion below already
# proves works. An empty expectation asserts the header is absent.
assert_header() {
  local path="$1" header="$2" expected="$3" actual
  actual="$(curl --silent --location --output /dev/null --write-out "%header{$header}" "$base$path")"
  [[ "$actual" == "$expected" ]] || { echo "MISMATCH at $path: $header was '$actual', expected '$expected'" >&2; exit 1; }
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

# An unknown URL must answer 404 with the site's own page, not nginx's stock
# body - which announces the server version.
assert_status_and_body "/nonexistent" 404 "BRANDED_404_PAGE"
assert_status_and_body "/legal/does-not-exist" 404 "BRANDED_404_PAGE"
# /404.html is `internal`, so it cannot be requested (and indexed) on a 200.
assert_status "/404.html" 404

# The RSC payloads and the raw legal Markdown must keep answering 200 - the
# .txt requests ARE client-side navigation, and commerce/src/legal-release.ts
# fetches the .md files over HTTPS to verify their sha256 - while being
# suppressed from indexing by header.
assert_body "/payment/success/__next._tree.txt" "rsc-tree-payload"
assert_header "/payment/success/__next._tree.txt" "X-Robots-Tag" "noindex"
assert_status_and_body "/legal/public-offer.md" 200 "# Публичная оферта"
assert_header "/legal/public-offer.md" "X-Robots-Tag" "noindex"

# nginx's add_header is not additive across levels: a location declaring any
# add_header REPLACES the whole server-level set. These three prove the
# re-declaration inside the .txt/.md location actually took.
assert_header "/payment/success/__next._tree.txt" "X-Content-Type-Options" "nosniff"
assert_header "/payment/success/__next._tree.txt" "X-Frame-Options" "DENY"
assert_header "/payment/success/__next._tree.txt" "Referrer-Policy" "no-referrer"

# An exact-match location outranks a regex one, which is what keeps robots.txt
# out of the block above. A robots.txt served with X-Robots-Tag: noindex is
# self-defeating.
assert_status "/robots.txt" 200
assert_header "/robots.txt" "X-Robots-Tag" ""
assert_header "/robots.txt" "X-Content-Type-Options" "nosniff"

# Content-hashed assets are immutable for a year; nothing outside that prefix is.
assert_header "/_next/static/chunks/app-abc123.js" "Cache-Control" "public, max-age=31536000, immutable"
assert_header "/_next/static/chunks/app-abc123.js" "X-Content-Type-Options" "nosniff"
assert_header "/index.html" "Cache-Control" ""
# A missing hashed asset is a build or deploy fault and must read as 404, not
# fall through to a page.
assert_status "/_next/static/chunks/absent-deadbeef.js" 404

# The one published city URL is retired to /schedule. Exact match only: a
# prefix or regex would turn every made-up city URL into a permanent redirect
# to a valid page, which is a manufactured soft-404 surface.
legacy_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$base/cities/saint-petersburg")"
[[ "$legacy_status" == "308" ]] || { echo "MISMATCH: expected 308 for the retired city URL, got $legacy_status" >&2; exit 1; }
legacy_location="$(curl --silent --output /dev/null --write-out '%header{location}' "$base/cities/saint-petersburg")"
[[ "$legacy_location" == "/schedule#saint-petersburg" ]] || { echo "MISMATCH: expected /schedule#saint-petersburg, got '$legacy_location'" >&2; exit 1; }
# An unknown city URL must still 404 with the branded body, not redirect.
assert_status_and_body "/cities/nonsense" 404 "BRANDED_404_PAGE"
assert_status_and_body "/cities" 404 "BRANDED_404_PAGE"

echo "Frontend nginx static-export routing: OK"
