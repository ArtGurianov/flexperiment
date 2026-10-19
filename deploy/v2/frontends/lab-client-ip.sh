#!/bin/sh
set -eu

# One startup snapshot supplies BOTH Real IP and original-socket-peer trust.
# Docker/network administration is the authority for the coolify-proxy alias.
# Never resolve the hostname independently in the two checks or trust a subnet.
peers=$(getent ahosts coolify-proxy | awk '{print $1}' | sort -u)
if [ -z "$peers" ]; then
    echo V2_LAB_CLIENT_SOURCE_CONFIGURATION_INVALID >&2
    exit 1
fi
realip=/etc/nginx/conf.d/lab-realip.inc
checks=/etc/nginx/conf.d/lab-client-ip.conf
: > "$realip"
for address in $peers; do
    # getent supplies numeric addresses. nginx validates their exact syntax.
    printf 'set_real_ip_from %s;\n' "$address" >> "$realip"
done
printf 'real_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n' >> "$realip"
{
    printf 'geo $realip_remote_addr $lab_guest_trusted_peer {\n    default 0;\n'
    for address in $peers; do printf '    %s 1;\n' "$address"; done
    printf '}\ngeo $remote_addr $lab_guest_client_is_proxy {\n    default 0;\n'
    for address in $peers; do printf '    %s 1;\n' "$address"; done
    printf '}\n'
} > "$checks"
