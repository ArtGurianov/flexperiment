# ART-39 — buyer route repair and isolated browser rehearsal

**BUYER_ROUTE_PREPARED_LIVE_CHECKOUT_NOT_ENABLED**,16October2026. [Receipts](receipts.json). This follows the [initial course preparation](../2026-10-16-paid-checkout-preparation/README.md); its original UNLISTED receipt remains historical.

## Actual canary correction

Through normal authenticated Control Room draft/publish APIs, changed only editorial course visibility from UNLISTED to LISTED, draft revision2/projection version2, with successful Platform invalidation. A buyer without entitlement can now use the existing public course-description fallback. No special UNLISTED purchasing route or access grant was added. Independent read-only SQLite observation at23:58UTC15October confirmed LISTED/PAID/CLOSED/100kopecks, empty acceptance allowlist, zero orders for this offer, zero course entitlements and zero fiscal policy versions. Payments remain disabled; other paid offers remain CLOSED. The150second independent video/freePreview=false are retained.

For eventual checkout the description must stay LISTED while the sole offer becomes ACCEPTANCE_ONLY. Listing the description does not grant lesson content or open sales. Public ingress403 guards remain a required installation read-back; this editorial change did not change routing.

## Browser finding and repair

A real Chromium browser against the uninstalled local candidate reproduced the reported Next16.3.3 Turbopack Blocking Route: the shared layout rendered AnalyticsConsentManager/usePathname outside Suspense for an unknown course slug. Wrapped only that leaf in Suspense fallback=null, following the bundled Cache Components migration guide. The course shell/footer remain outside the boundary; no instant=false opt-out or analytics/consent behavior change. Next-generated app AGENTS/CLAUDE instructions are retained as required by repository guidance.

Local production build, Platform TypeScript/ESLint and all136Platform tests pass. Repeated the actual Next page and Commerce HTTP preview with a synthetic authenticated customer and no entitlement, an in-memory database and MockPaymentRail. Page rendered; price1₽, eight document links and receipt contact appeared; a synthetic document opened; confirmation was disabled until the unchecked checkbox was deliberately selected, then enabled. Never clicked the final payment button. The fixture's provider create always refuses. The synthetic handoff, auth, fiscal/legal fixtures and local HTTP documents are explicitly not live approval, provider qualification or a genuine-buyer E2E. Private screenshot/source are retained in owner artifact custody.

Actual UI order is course → signed handoff → preview(price/documents/contact) → review and checkbox → final create. Preview itself records no durable acceptance; order creation records it atomically. Keep the genuine selected-buyer/private-gateway/provider-return check as a post-install gate. Installation and final legal/fiscal activation are still HOLD, so this local proof must not be relabeled as that check or used to close ART-39/224.

## Concrete merchant and installation preparation

A private production manifest review candidate now binds the real Business/OWNER, independent saved owner-identity manifest, exact platform seed, only /checkout/return and checkout/refund/fulfillment scopes. Strict parsers pass; read-only live comparison under refref_runtime confirms registry/owner/platform identity, zero merchant keys/offers. No bank/bootstrap writes or key issuance occurred. It is a review candidate, not an admitted or executed manifest. The zero-reward terms and signed-regulation hash reference are technical proposals requiring exact manifest review before immutable publication.

Consumer tracing also requires an admitted Refref runtime map entry from the returned evidencePolicyVersionId; provisioning alone does not reload the process-start UNATTRIBUTED_EVIDENCE_POLICIES map. That shared production config application stays under installation HOLD.

See the [bounded installation packet](../../release/ART-39_INSTALL_PACKET.md) for custody, exact role vector, backup and remaining HOLDs. ART-338 stays Done; ART-39/83/224 stay open.
