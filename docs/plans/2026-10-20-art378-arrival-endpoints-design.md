# ART-378 (B2) — storefront arrival endpoints and browser-context lifecycle

**Normative source:** refref ADR-139 (docs/29) §2, §4, §6, §8; `docs/openapi-vnext.yaml`
(`claimArrival`, `closeBrowserContext`, `BrowserContextResolutionRequest`). Builds on B1 (ART-373,
durable intent) and on Refref C1/C2 (ART-374/375). C3 resolution and the D payment slice (ART-379)
are out of scope: the RC.2 rail still ignores the frozen context fields.

**HOLD:** code only. No deployment, migration of a live database, Refref origin admission, real
payment or sales activation. The feature is off unless `BROWSER_CONTEXT_ENABLED=true`.

## Shape

| Piece | Where | Decision |
| --- | --- | --- |
| LMS arrival endpoint | `apps/platform/app/arrive/route.ts` | Forwards `/arrive?arrival=…&to=…` to Commerce on the platform origin; not reachable through the public `/v1/*` proxy allowlist. |
| LAB arrival endpoint | `deploy/v2/frontends/lab-v2.conf.template` `location = /arrive` | Same Commerce route on the LAB origin; `/v1/browser-context/*` stays 404 there. |
| Endpoint, context, proof, exchange | `commerce-v2/src/browser-context.ts`, migration 0034 | Commerce owns the DB, the Refref key and the after-response lifecycle, so both origins share one implementation. Storefront = forwarding host, never a parameter. |
| Cookie | `__Host-flx-ctx-lms` / `__Host-flx-ctx-lab` | HTTP `Set-Cookie` only; HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; Max-Age per storefront (default 30 days, ≥ 24 h). Distinct names so two origins on one host in development never share a context. |
| Context IDs | merchant-generated, 256-bit base64url | A presented unknown, expired, rotated or foreign-storefront ID is never adopted; a fresh ID is issued. |
| After-response work | `commerce-v2/src/after-response.ts` | Tracked tasks, drained on SIGTERM/SIGINT (≤ 2 s). Not an untracked Promise. |
| Claim client | `commerce-v2/src/refref-arrival-exchange.ts` | Closed body `{arrivalProof, browserContextId, storefrontOrigin}`; 201/200 receipt echo checked. Final: 422, `ARRIVAL_ALREADY_CLAIMED`, `CONTEXT_SCOPE_MISMATCH`, 400. `CONTEXT_CLOSED` re-homes. Everything else (timeout, transport, 5xx, 429, idle policy missing) is UNKNOWN and retried. |
| Page-view retry | `apps/platform/proxy.ts` | Only with the LMS cookie, never prefetches/assets/API; `event.waitUntil` keeps the internal touch alive. LAB page loads already call `/v1/lab/catalogue` and `/v1/me`. |

## Lifecycle

- **Landing:** reuse the ACTIVE context (A-then-B arrivals share it) or create one; store the proof
  (raw only while PENDING, unique by SHA-256); 303 to the `to` path on the same origin, never to
  another origin, `/arrive` or `/v1`; schedule one ≤ 500 ms claim attempt after the response.
- **Later requests:** every `/v1` request with a context cookie, and every platform page view,
  schedules a retry after its response: single-flight per proof, at most once per 2 s, never after
  `captured_at + 30 min` (the proof is then EXPIRED and cleared). Merchant capture time is never
  earlier than Refref `issuedAt`, so the local window never outlives Refref's.
- **LMS account boundary:** the first signed-in account seen binds an anonymous context (anonymous
  click → login → Buy keeps the Arrival). Sign-out always rotates, bound or not. A request from a
  different account, or signed out, in a bound context rotates it. Rotation abandons pending proof,
  issues a new ID and queues an idempotent close (after the response, then the 30 s sweep until
  acknowledged). A background retry never claims into a context awaiting rotation.
- **Refref closed the context:** a successor with the same binding takes the unconfirmed proofs and
  reaches the browser on its next cookie-setting response; a closed successor fails the proof.
- **Buy:** if an intent already exists for the idempotency key or order, its frozen context is sent
  unchanged. Otherwise admit the context, spend ≤ 1,500 ms on attempts, and freeze
  `deliveryDegraded`: FAILED if any proof failed, else EXPIRED if any expired, else TIMEOUT if any is
  still pending, else `{degraded: false}`. A late ACK never clears the frozen flag.
- **Retention:** contexts and their arrivals are deleted after the cookie lifetime unless a close is
  outstanding; an LMS binding cascades on customer erasure. Reviewed schema hashes updated in
  `erasure-restore.ts` and `pd-retention.ts`.

## Tests (ART-378 list)

`commerce-v2/test/browser-context.test.ts` (55), `apps/platform/test/browser-context.test.ts` (7),
`scripts/v2/test_frontend_proxy.py::test_lab_arrival_endpoint_reaches_commerce_and_nothing_else`.

| ART-378 test | Covered by |
| --- | --- |
| Server cookie after decorated URL | Set-Cookie attributes on both origins; local Chromium run against the real app (cookie stored HttpOnly/Secure/Lax/host-only, invisible to JS, clean URL, no proof in referrer). **Safari/WebKit and in-app WebViews: manual check pending** (no WebKit runtime here). |
| Clean redirect without blocking | 303 returned with zero claims made; claim runs after the response. |
| Forced first-attempt failure + anonymous page-view retry | LAB catalogue load and platform touch retries; rate limit and single-flight. |
| Expired claim | No attempt after 30 min; Buy freezes EXPIRED. |
| LMS anonymous click → login → Buy | Context bound on `/v1/me`, same ID frozen, undegraded. |
| LMS logout A → login B | New ID, old ROTATED and closed, A's proof ABANDONED, B's intent on the new ID; account switch without sign-out; stale second tab. |
| LMS page referral then LAB purchase | LAB intent uses its own LAB context; only the LMS origin was claimed. |
| No token leaks | No proof in any console line, Location, frozen intent, settled row or alert; nginx logs; closed claim body without buyer identity. |

## Open before the LMS/LAB slices of ART-379

- Safari/WebKit and Telegram/Instagram WebView arrival check on the real hosts.
- Owner sets `BROWSER_CONTEXT_*_MAX_AGE_SECONDS` to at least the longest campaign window per origin.
- Refref admits each origin (`vnext_arrival_origin`) with link destinations of the form
  `https://<origin>/arrive?to=<path>`; `REFREF_VNEXT_API_BASE_URL` is set at the staged cutover.
- The D slice sends the frozen request to Refref vNext and handles `CONTEXT_CLOSED` at resolution.
- LAB guest Buy (ART-384) freezes the LAB guest context the same way; guest order recovery and tickets stay merchant-side.
