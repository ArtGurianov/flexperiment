# apps/my — my.flexperiment.ru

Skeleton for FLEX-120/121 (B). Contract: `docs/plans/2026-11-20-my-identity-session-exchange-design.md`.

| Path | Owner |
| --- | --- |
| `app/sign-in`, `app/continue`, `app/v1/[...path]` (proxy), `app/healthz`, `app/identity`, `lib/commerce-proxy.ts`, `Dockerfile.my` | B (FLEX-120/121) |
| `app/checkout/**` | FLEX-122 |
| `app/(cabinet)/**` (`/`, `/orders`, `/profile`) | FLEX-123 |

Port 3003. Env: `MY_ORIGIN`, `PLATFORM_ORIGIN`, `COMMERCE_INTERNAL_ORIGIN`, `SOURCE_COMMIT`/`BUILD_IDENTITY_FILE`.
No analytics or third-party scripts. The release process (E) admits the image; this package does not deploy.
