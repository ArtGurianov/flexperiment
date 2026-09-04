#!/usr/bin/env bash
set -euo pipefail

# Phase 9: one frontend container serves TWO public hostnames -
# admin.flexperiment.ru and partner.flexperiment.ru. This proves both the
# static config content AND the live routing behavior: each host serves
# only its own realm's pages, refuses the other realm's pages with 404, and
# proxies each realm's API prefix to Commerce - never the other's.

config_path="$PWD/deploy/admin.nginx.conf"

docker run --rm \
  -v "$config_path:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.29-alpine nginx -t

rendered="$(docker run --rm \
  -v "$config_path:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.29-alpine nginx -T 2>&1)"

grep -Fq 'resolver 127.0.0.11 valid=5s ipv6=off;' <<<"$rendered"
grep -Fq 'set $commerce_upstream commerce:3001;' <<<"$rendered"
grep -Fq 'proxy_pass http://$commerce_upstream;' <<<"$rendered"
grep -Fq 'location /v1/admin/' <<<"$rendered"
grep -Fq 'location /v1/partner/' <<<"$rendered"
grep -Fq 'server_name admin.flexperiment.ru;' <<<"$rendered"
grep -Fq 'server_name partner.flexperiment.ru;' <<<"$rendered"

# --- Live routing contract: fixture static tree + a stub Commerce backend
# distinguishing /v1/admin/ from /v1/partner/, served through the real
# nginx config with Host-header-selected server blocks. -----------------

fixture_dir="$(mktemp -d)"
response_file="$(mktemp)"
net_name="flexperiment-admin-nginx-routing-net-$$"
nginx_container="flexperiment-admin-nginx-routing-nginx-$$"
commerce_container="flexperiment-admin-nginx-routing-commerce-$$"
host_port=$((21000 + RANDOM % 10000))

cleanup() {
  docker rm -f "$nginx_container" "$commerce_container" >/dev/null 2>&1 || true
  docker network rm "$net_name" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir" "$response_file"
}
trap cleanup EXIT INT TERM

mkdir -p "$fixture_dir/agents" "$fixture_dir/partner/login" "$fixture_dir/partner/profile" "$fixture_dir/_next/static/chunks"
echo "ADMIN_DASHBOARD_PAGE" > "$fixture_dir/index.html"
echo "ADMIN_AGENTS_PAGE" > "$fixture_dir/agents/index.html"
echo "PARTNER_LOGIN_PAGE" > "$fixture_dir/partner/login/index.html"
echo "PARTNER_PROFILE_PAGE" > "$fixture_dir/partner/profile/index.html"
echo "console.log('shared asset')" > "$fixture_dir/_next/static/chunks/app-abc123.js"
# mktemp -d creates 0700; nginx's worker (uid 101) needs read access.
chmod -R a+rX "$fixture_dir"

docker network create "$net_name" >/dev/null

# A minimal stub standing in for Commerce: echoes which realm prefix it was
# reached under, so the proxy_pass target can be told apart from the static
# routing decision above it.
docker run -d --name "$commerce_container" --network "$net_name" --network-alias commerce \
  nginx:1.29-alpine sh -c '
    mkdir -p /usr/share/nginx/html/v1/admin /usr/share/nginx/html/v1/partner
    echo "COMMERCE_ADMIN_SURFACE" > /usr/share/nginx/html/v1/admin/index.html
    echo "COMMERCE_PARTNER_SURFACE" > /usr/share/nginx/html/v1/partner/index.html
    cat > /etc/nginx/conf.d/default.conf <<EOF
server {
    listen 3001;
    root /usr/share/nginx/html;
    location / { try_files \$uri \$uri/index.html =404; }
}
EOF
    exec nginx -g "daemon off;"
  ' >/dev/null

docker run -d --name "$nginx_container" --network "$net_name" \
  -p "127.0.0.1:$host_port:80" \
  -v "$fixture_dir:/usr/share/nginx/html:ro" \
  -v "$config_path:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.29-alpine >/dev/null

base="http://127.0.0.1:$host_port"
ready=0
for _ in $(seq 1 40); do
  curl --silent --fail --output /dev/null -H "Host: admin.flexperiment.ru" "$base/healthz" && { ready=1; break; }
  sleep 0.25
done
[[ "$ready" == 1 ]] || { echo "nginx never became ready on $base/healthz" >&2; docker logs "$nginx_container" >&2 || true; exit 1; }

assert_body() {
  local host="$1" path="$2" expected="$3" actual status
  status="$(curl --silent --output "$response_file" --write-out '%{http_code}' -H "Host: $host" "$base$path")"
  actual="$(cat "$response_file")"
  [[ "$status" == "200" ]] || { echo "MISMATCH host=$host path=$path: HTTP $status, expected 200" >&2; docker logs --tail 20 "$nginx_container" >&2 || true; exit 1; }
  [[ "$actual" == "$expected" ]] || { echo "MISMATCH host=$host path=$path: got '$actual', expected '$expected'" >&2; exit 1; }
}
assert_status() {
  local host="$1" path="$2" expected="$3" actual
  actual="$(curl --silent --output /dev/null --write-out '%{http_code}' -H "Host: $host" "$base$path")"
  [[ "$actual" == "$expected" ]] || { echo "MISMATCH host=$host path=$path: got HTTP $actual, expected $expected" >&2; exit 1; }
}

# 1/2: each host serves its own surface.
assert_body admin.flexperiment.ru "/" "ADMIN_DASHBOARD_PAGE"
assert_body admin.flexperiment.ru "/agents/" "ADMIN_AGENTS_PAGE"
assert_body partner.flexperiment.ru "/partner/login/" "PARTNER_LOGIN_PAGE"
assert_body partner.flexperiment.ru "/partner/profile/" "PARTNER_PROFILE_PAGE"

# 3/4: cross-realm page requests fail closed with 404, not a silent fallback.
assert_status admin.flexperiment.ru "/partner/login/" "404"
assert_status admin.flexperiment.ru "/partner" "404"
assert_status partner.flexperiment.ru "/agents/" "404"
assert_status partner.flexperiment.ru "/" "301"   # redirects to /partner/, never serves the admin dashboard

# 5: shared static assets remain reachable from both hosts (public, content-addressed, no authority).
assert_body admin.flexperiment.ru "/_next/static/chunks/app-abc123.js" "console.log('shared asset')"
assert_body partner.flexperiment.ru "/_next/static/chunks/app-abc123.js" "console.log('shared asset')"

# 6/7: each host proxies only its OWN API prefix to Commerce.
assert_body admin.flexperiment.ru "/v1/admin/" "COMMERCE_ADMIN_SURFACE"
assert_body partner.flexperiment.ru "/v1/partner/" "COMMERCE_PARTNER_SURFACE"
assert_status admin.flexperiment.ru "/v1/partner/" "404"
assert_status partner.flexperiment.ru "/v1/admin/" "404"

# 8: an unrecognized Host never resolves to either realm.
assert_status unknown.flexperiment.ru "/" "404"
assert_status unknown.flexperiment.ru "/agents/" "404"
assert_status unknown.flexperiment.ru "/partner/login/" "404"

echo "Admin/Partner shared-frontend host routing: OK"
