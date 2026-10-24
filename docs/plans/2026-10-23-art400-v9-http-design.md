# ART-400: isolated v9 purchase HTTP rail

The owner approved implementation and local E2E on 23 October 2026. This branch adds `RefrefV9PaymentRail` against the opt-in Refref purchase HTTP boundary. Default RC.2 behavior and sales switches remain unchanged. The new class and `REFREF_V9_LOCAL_HTTP_URL` startup switch reject staging/production; they serve only an explicitly configured local/test stand. D8 and ART-412 remain CLOSED.

The financial schemas/oracle remain vendored at Refref `93b6a41fc42b4d616f381d65573e20fceaf79e78`. The separate HTTP wrapper uses `/v1-v9/integrations/purchases`, by-purchase quote readback, `/payment` creation/readback and `/fulfillment` acknowledgment. Refref owns and persists payable/2, terms and policy; Flexperiment keeps freezing its input before RPC and independently checking every payable/qualification binding before access.

The client uses native HTTP, validates closed quote/payment responses and keeps unknown outcomes ambiguous. A malformed success triggers by-order readback, never a new order/key or refreshed deadline. Deterministic binding/hash failures refuse resolution. A lost payment response reads the original purchase; an authenticated no-attempt readback can only repeat the same server-idempotent command when current creation admission permits it. Known attempts and reconciliation never create money. Missing qualification preserves REVIEW_REQUIRED and its narrowly selected read-only retry reason.

The server persists one pre-payment attempt per Business/purchase before submission; distinct HTTP keys cannot create another. Independently ingested bank facts are required for qualification. Customer fiscal contact travels separately from the financial manifest and is redacted in evidence. The rail explicitly refuses refund methods until a matching v9 refund transport is qualified; it does not fall back to RC.2.

`commerce-v2/test/fixtures/v9-http-contour.ts` is a spawned stand driver. It starts the real application, legal/fiscal/readiness/hold gates and an actual HTTP listener against Refref, using synthetic local identities and payment evidence. It is not part of runtime startup. `Dockerfile.v9-qualification` packages that driver with the exact dependency lock and source; it is not a release image.

The Refref runner owns disposable PostgreSQL identity, installation and cleanup. Its process contour can use this checkout through `REFREF_V9_FLEXPERIMENT_SOURCE`; the container contour requires both built qualification images. It records sanitized HTTP transcripts, transport witnesses, image/source identities and durable counts. Local clocks must respect the existing strict chronology; tests wait for real authoritative DB time rather than inventing timestamps.

Local scope: LMS and guest LAB separately, explicit legal consent, one payment/entitlement/ticket, last-seat refusal, lost ACK after commit and restart, malformed quote/readback, terminal retry, foreign order/hash refusal, delayed bank qualification. Browser navigation, live identity/proxy/quota installation, independent bank/profile qualification and ART-412's other blockers are separate. Multi-line financial vectors do not introduce a buyer basket; current merchant storefronts remain one offer per intent.

CUSTODY_IMPACT: NO — source and isolated disposable fixtures only. No merge, host installation, bank operation, production migration, profile opening or financial activation is authorized by this branch.


## Approved bounded resilience/F02 extension — 24 October 2026

The stand now checks four persisted crash classes (including distinct money and
access checkpoints), three controlled races and the earliest TTL/hold/LAB-start
deadline. Refref's real HTTP child is killed with SIGKILL; its provider journal
and disposable PG survive. No universal fault-injection framework is introduced.

The default refund refusal remains. A rail instance may explicitly set
`externalRefundObservation: true` in a local/test stand to observe already
performed external refunds using GET-only Refref readback. This is not bank
refund execution: existing `prepareRefund`/`submitRefund`/execution reconciliation
seams retain a sealed observation envelope and apply only independently bound
SUCCEEDED allocations totalling the original full line amount. The existing
Flexperiment full-line refund/access rules are retained; partial or PENDING
readbacks preserve access. No bank write, fiscal-return qualification or RC.2
fallback is added. Runtime startup does not enable this observation opt-in.

F02 uses existing Control Room session-authenticated approval/execution handlers
and existing entitlement/ticket updates. Refref product claim/supplement/decision
commands use a different session boundary; merchant cannot import bank/schedule
facts or impersonate a MODERATOR. Independent evidence stores remain separate.
A financial multi-line wire test checks D1.2 equality without claiming a basket
UI. The EXPIRED case is a labelled historical fixture, not a real ten-day wait.

Targeted tests precede final exact-head CI and container qualification. Earlier
proof bundles remain unchanged. Browser Better Auth login, production quota,
provider profiles, legal/fiscal acceptance and ART-412 are separate gates.
