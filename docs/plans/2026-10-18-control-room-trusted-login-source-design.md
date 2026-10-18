# ART-31: trusted Control Room login source and account limits

Owner GO: 18 October 2026, package2 independent Draft PR. This slice implements
the accepted IP-chain repair; TOTP and service-token retirement remain separate
ART-31 work. No deployment, VPS change, database migration or sales activation.

## Trust boundaries

1. Traefik sanitizes forwarded headers at its entrypoint (no
   `forwardedHeaders.insecure`). nginx trusts only the resolved `coolify-proxy`
   peer, with `real_ip_header X-Forwarded-For` and `real_ip_recursive off`: the
   last address Traefik supplies wins, never a client-supplied leftmost value.
   Other peers cannot select their own replacement address. This applies to
   both the V2 Admin artifact and the fast-cut Admin configuration.
2. nginx removes `CF-Connecting-IP` and `Forwarded`, replaces `X-Real-IP` and
   `X-Forwarded-For` with the resolved address, and preserves the existing host,
   HTTPS, cookie, no-store and route boundaries.
3. Commerce uses the Node socket peer, not a presented header, to admit the
   proxy. `CONTROL_ROOM_TRUSTED_PROXY_IPS` lists exact Admin nginx IP addresses;
   no CIDRs, hostname guesses or Docker-wide trust. Only a trusted peer's single
   valid `X-Real-IP` is a login source. Missing config, missing/invalid header or
   untrusted peer refuses login before password verification. CF and XFF are
   never fallbacks. IPv4-mapped IPv6 and equivalent IPv6 spellings canonicalize
   before comparison/hashing.

Blind header trust would leave the direct Commerce path spoofable; trusting a
Docker subnet would admit unrelated containers. Exact peers keep the boundary
reviewable at the cost of explicit read-back/configuration during installation.

## Rate limits

Keep IP budgets5/15min and20/day. Add singleton-admin budgets20/15min and100/day
across all admitted source IPs. Consume all four counters in one SQLite
`BEGIN IMMEDIATE`; refusal rolls back partial charges. The existing table and
hashed keys suffice, so no merchant DDL or migration is added. Failed and
successful admitted login attempts consume budget; rejected proxy metadata does
not. Fixed windows do not extend when a blocked caller retries. A distributed
attacker can still exhaust the deliberate account budget; it bounds guessing
and does not promise DoS immunity or recovery bypass.

## Validation and future installation

Unit/HTTP tests cover forged CF/XFF, per-IP isolation, rotation across real
source IPs hitting the account cap, both time windows, persistence, rollback,
missing/untrusted metadata and normal login/logout. The existing Docker proxy
suite exercises real nginx and Traefik on an isolated network, including
attacker-supplied forwarded-header chains and direct nginx access.

Before any separately authorized installation, read back Traefik's entrypoint
settings and `coolify-proxy` DNS on the Admin network; set the exact nginx peer
IPs in Commerce and verify the served chain. Recreated proxy containers require
renewed peer read-back/configuration; nginx resolves the Traefik name at start
and needs reload/recreation if that address changes. No fallback to a subnet or
to `unknown` is permitted. This Draft does not qualify the external canary
access guard or authorize applying configuration on the VPS.

References: [nginx realip](https://nginx.org/en/docs/http/ngx_http_realip_module.html),
[Traefik forwarded headers](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/#forwarded-headers),
[Hono Node connection metadata](https://hono.dev/docs/helpers/conninfo).
