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

Keep hard IP budgets of 5/15min and 20/day. The singleton account has **no
attempt cap or lockout**. In each 15-minute account window the first five
admitted attempts have no extra wait, then the waits are 1, 2, 4 and at most
5 seconds. The short cap leaves headroom under the existing 15-second nginx
read timeout; a 30-second wait would require a separate timeout change.

Consume both IP counters and reserve the account attempt number in one SQLite
`BEGIN IMMEDIATE`. An exhausted IP rolls back every partial charge; the
account counter never refuses admission. The existing table and hashed keys
suffice, without merchant DDL or migrations. Reopening the database or using a
second connection cannot reset the shared account history.

Each admitted request commits its own delay before yielding, then awaits it
**before password verification**. Concurrent requests receive their own
committed delays instead of racing to read zero failures. New traffic cannot
postpone a pending request, and there is no unbounded global queue. This is a
bounded per-request penalty, not an aggregate account throughput cap. Even
under distributed failures, a correct password from an IP with remaining
budget can succeed after its bounded wait. Account history is not reset by
successful or aborted requests; cancellation only stops that request's wait.

## Validation and future installation

Unit/HTTP tests cover forged CF/XFF, per-IP isolation, rotation across real
source IPs retaining correct login, bounded concurrent waits, both IP windows,
persistence across connections/reopening, rollback,
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
