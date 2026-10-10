#!/bin/sh
set -eu

# Only the isolated, already approved Commerce canary identity and V2 port.
# A rolling Coolify container name may be supplied until a stable alias exists.
# Do not default to commerce:3001, a production UUID, URL or arbitrary hostname.
case "${V2_COMMERCE_UPSTREAM:-}" in
    *[!a-zA-Z0-9:-]*) echo V2_FRONTEND_CONFIGURATION_INVALID >&2; exit 1 ;;
esac
if ! printf '%s' "${V2_COMMERCE_UPSTREAM:-}" | grep -Eq '^xzuy7pk5y6ywjr9kh6nsk5ap(-[0-9]{8}T[0-9]{6})?:3002$'; then
    echo V2_FRONTEND_CONFIGURATION_INVALID >&2
    exit 1
fi
service=$(cat /app/.identity/service)
case "$service" in
    lab-v2|admin-v2) ;;
    *) echo V2_FRONTEND_CONFIGURATION_INVALID >&2; exit 1 ;;
esac
# Explicit envsubst allowlist leaves nginx variables intact. No secret is read.
envsubst '$V2_COMMERCE_UPSTREAM' < "/etc/nginx/v2/$service.conf.template" > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
