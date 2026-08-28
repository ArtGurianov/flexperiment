# Admin web deployment

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

## Emergency sales control

The dashboard emergency control owns `emergency_sales_gate`, never
`release_sales_gate`. It requires a reason and the currently displayed revision;
the command is idempotent and uses compare-and-swap. It is an absolute stop,
including certification orders. Reopening clears only this operator gate: a
release pause or corrupt release ledger remains visible as `release_paused` and
continues to block purchases. Operators may use the control while a release
owns its independent deployment gate.
