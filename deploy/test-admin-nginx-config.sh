#!/usr/bin/env bash
set -euo pipefail

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

echo "Admin nginx dynamic Commerce DNS config: OK"
