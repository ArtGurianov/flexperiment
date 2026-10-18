# Admin web deployment

## V2 Control Room login source (ART-31)

This V2 slice uses `deploy/v2/frontends/admin-v2.conf.template` or the fast-cut
Admin configuration, not the legacy V1 deployment below. Password + TOTP and
service-token retirement are separate ART-31 increments; this change does not
claim either is complete.

The trusted path is Traefik → Admin nginx → Commerce. nginx resolves the exact
`coolify-proxy` peer at startup, reads the final Traefik X-Forwarded-For address
with `real_ip_recursive off`, removes `CF-Connecting-IP`/`Forwarded`, and replaces
X-Real-IP/X-Forwarded-For. Traefik's entrypoint must sanitize untrusted forwarded
headers (`forwardedHeaders.insecure=false`; no unqualified upstream trust).

Before a separately authorized installation, read back the Admin nginx IP as
seen by Commerce, and configure `CONTROL_ROOM_TRUSTED_PROXY_IPS` in Commerce as
comma-separated exact IPs. IPv4 and IPv6 are supported; no subnet, hostname,
public client address or `0.0.0.0/0`. Multiple IPs permit a reviewed proxy
rollover. Remove the previous peer after verifying the new one. Re-read peers
after container recreation; reload nginx if Traefik's resolved address changes.
Do not weaken trust if the two services cannot resolve/reach the expected peer.

No configured peers gives login503 (`CONTROL_ROOM_PROXY_NOT_CONFIGURED`). An
untrusted/missing socket peer or invalid/missing X-Real-IP gives403
(`CONTROL_ROOM_SOURCE_NOT_TRUSTED`). Neither request consumes password budget.
CF and XFF never substitute for missing transport evidence. Existing authenticated
sessions remain subject to their normal expiry/revocation/Origin checks.

Admitted attempts atomically consume the persisted IP counters (5/15min,
20/day) and reserve an account attempt number. Only IP exhaustion returns
429 `RATE_LIMITED`; an exhausted IP does not partially charge account history.
The singleton account has no hard cap or lockout. In each 15-minute account
window the first five attempts are immediate, then each waits 1, 2, 4 and at
most **5 seconds before password verification**. This remains below nginx's
15-second read timeout. A correct password from an IP with remaining budget
still succeeds after the bounded wait, including after distributed failures.

Concurrent attempts reserve their delays in SQLite before waiting; restarting
an app or rotating source IPs cannot bypass the history. Each pending request
has its own fixed wait: later traffic cannot postpone it or create an unbounded
queue. This is a per-request delay, not a global account throughput limit.
Aborted requests stop waiting without refunding counters; successful requests
do not erase shared history. Keys hash the canonical source with the session
secret; raw IPs and credentials are not stored in the counter table. No schema
migration is needed. TOTP remains a separate security slice.

The local proxy fixture verifies real Traefik/nginx forwarding on an isolated
network. It does not qualify external reachability through the restricted
canary guard. Applying configuration, rebuilding/reloading services, changing
VPS or opening sales needs its separate operational GO.

## Legacy V1 deployment reference

`admin-web` is a static Next.js export served by Nginx. It has no Node runtime,
SSR, route handlers, middleware, or secrets in its image.

## Build and routing

Build it with `Dockerfile.admin`. Attach `admin.flexperiment.ru` to the
resulting service and make the service able to resolve the Commerce service as
`commerce` on port `3001`.

Nginx serves the exported files and proxies only `/v1/admin/*` to Commerce.
The browser therefore uses the same `admin.flexperiment.ru` origin for both
the UI and API; the existing host-only `fx_admin_session` cookie continues to
work without browser token storage or cross-origin CORS.

Commerce is resolved through Docker DNS at proxy time (`127.0.0.11`, IPv4
only), rather than once when Admin starts. Admin must therefore survive a
Commerce container/IP replacement during a rolling redeploy without an Admin
restart. The two services must remain on the same Docker network with the
Commerce service addressable as `commerce:3001`.

The health check endpoint for this static service is `/healthz` on port `80`.

## Required deployment sequence

1. Deploy Commerce first, including migration `0008` and the Admin read/session
   endpoints.
2. Build and deploy `admin-web` from `Dockerfile.admin` as a separate Coolify
   service, on the same internal network as `commerce`.
3. Verify `https://admin.flexperiment.ru/healthz` and Admin login.
4. Verify `/v1/admin/session` after browser reload, then logout.

The current certification database is intentionally retained. It supplies
read-only evidence fixtures for `CREATE_UNKNOWN`, technical reservation
abandonment, paid ticket delivery, and a succeeded refund.

## Mutation safety

The UI holds one `Idempotency-Key` for each user intent. On network ambiguity
it does not generate another command automatically: inspect the relevant
catalog row or order evidence before deciding whether to replay the same key.
No UI routes exist for force-changing payment, booking, ticket, or provider
reference state.

## Occurrence inventory

An occurrence's available seats are capacity minus customer commitments and the
admin reserve. Raising the reserve can therefore make sales sold out and make
the availability waitlist eligible; lowering it can immediately release seats.
The occurrence editor shows sold, in-payment, reconciling, and admin-reserved
commitments, and the server is authoritative for the minimum allowed capacity.

## Emergency sales control

The dashboard emergency control owns `emergency_sales_gate`, never
`release_sales_gate`. It requires a reason and the currently displayed revision;
the command is idempotent and uses compare-and-swap. It is an absolute stop,
including certification orders. Reopening clears only this operator gate: a
release pause or corrupt release ledger remains visible as `release_paused` and
continues to block purchases. Operators may use the control while a release
owns its independent deployment gate.
