# Flexperiment LMS and LAB on Refref v10

Date: **27 October 2026**. Status: **architecture audit and transition plan for owner review**. Code, SQL, published legal texts, provider settings, the storefront switch and sales are not changed by this package.

Refref v10 moves the buyer's checkout, payments, refunds and fiscal receipts to the merchant. Refref keeps attribution, the one-use `BOUND` record, the one purchase-level commission and its finality, merchant claims, the monthly partner registry and payout disputes. For Flexperiment this is a larger change than a new API client: today Refref is the payment rail of both storefronts.

## Reading order

1. [Architecture](01-architecture.md) — what the source does today, the new boundary and the minimal domain changes.
2. [LMS and LAB profiles](02-lms-and-lab-profiles.md) — finality mode, access, tickets, occurrence changes and refunds per storefront.
3. [Refref integration](03-refref-integration.md) — Arrival to v10 touch, promo codes and Apply, `BOUND` before payment, outcome reporting, claims and partner payouts.
4. [Fiscal, legal and data](04-fiscal-legal-data.md) — native receipts, buyer offers, personal data and the public-repository boundary.
5. [Migration and E2E](05-migration-and-e2e.md) — inventory, staged implementation, cutover and rollback, planned E2E scenarios.

## Pinned sources

| Source | Exact basis | Use |
|---|---|---|
| Flexperiment `origin/main` | [`c8bad757c9daa04385f9cf5e95bf6e07b185080a`](https://github.com/ArtGurianov/flexperiment/tree/c8bad757c9daa04385f9cf5e95bf6e07b185080a) | Source audit of `commerce-v2` (35 migrations `0001`–`0035`), `apps/platform`, `apps/lab`. Not an installed database or a running host |
| Refref v10 package | Refref PR #130 at `c932b656edbda1d47cfb57de08fd4a36536712f5`, `docs/v10` | The canonical rules (ADR-141 and contracts). The PR is **open, not merged**; the repository is private, so these links need access |
| Previous Flexperiment target | [Refref v9 contract status](../refref-v9-contract-status.md), [checkout protocol](../refref-checkout-protocol.md) | Historical target and retained RC.2 implementation; not carried into new v10 rights |
| Owner task | LMS and LAB documentation PR by analogy with Mikluha | Does not choose providers, prices, refund policy or legal roles |

File hashes are in [source-baseline.json](source-baseline.json). This package does not copy Refref's internal procedures; where a rule belongs to Refref, the plan states only what Flexperiment must do and links the pinned contract. When PR #130 changes or is squash-merged, re-pin and re-check the affected requirements together with the hashes.

## Already decided by the Refref v10 owner decisions

- Flexperiment owns checkout, every payment and refund, access, tickets and receipts. Refref does not take buyer money.
- A referral right exists only through a `BOUND` that Refref stored before the first chance to pay. No retroactive binding, no recovery by order history.
- One commission `C` per purchase, fixed at the first actual full payment; base `G` is the eligible amount after Flexperiment's own discounts and before the Refref discount. `C` does not depend on whether the buyer used the Refref discount.
- Outcomes of bound purchases are reported automatically; organic sales and a refund stream are not reported.
- Reducing `C` needs a merchant claim with evidence; the result is the whole `C` or zero, never a pro-rata amount.
- Flexperiment pays partners directly in RUB on the monthly registry.
- Public launch of Refref v10 needs real E2E of LMS, LAB and Mikluha.

## Flexperiment decisions needed before the money profile

These are Flexperiment parameters, not Refref decisions. A developer must not fill them with a "reasonable default".

| ID | To choose or qualify | Must not be assumed |
|---|---|---|
| FX-C01 | Native acquiring provider, merchant account, refund capability (full and partial), read-back API and idempotency | That the Refref rail, its credentials or its provider qualification carry over |
| FX-C02 | Fiscal profile: who issues receipts, cash register/OFD, tax system, payment method/object per product, advance-offset receipts for LAB | `fiscalizationMode=PROVIDER`, `USN_INCOME` or the current snapshot values as a legal basis |
| FX-C03 | Finality mode per product kind: proposed `PAYMENT` for `ONLINE_COURSE`/`COURSE_BUNDLE`, `SCHEDULED_SERVICE` for `LAB` with the occurrence end as anchor | A mode derived from fiscal tags, access activation or lesson progress |
| FX-C04 | `fullPaymentDueAt` for immediate 100% payment (for example the payment-session deadline) | A value computed from the touch lifetime or request time |
| FX-C05 | Buyer refund and cancellation policy per product, including partial refunds and refunds after course access | That today's full-only rule is the policy, or that a Refref claim decision drives a buyer refund |
| FX-C06 | Promo codes: whether a Flexperiment promotion and a Refref discount may stack in one order, and the code entry/Apply UI | That the current single code field already implements v10 Apply |
| FX-C07 | Partner payout operations: payer account, who prepares and executes the monthly registry, reporting duties | That payouts are Refref's job |
| FX-C08 | Instalments or deposits for any course or LAB edition | That LMS/LAB need deposits; the plan keeps one full payment unless the owner chooses otherwise |
| FX-C09 | Updated buyer offers, payment rules, personal-data instruction to Refref and consents | That the published texts describing Refref as payment intermediary stay valid |
| FX-C10 | Inventory of existing RC.2 attempts, refunds and any referral rights; cutover and rollback plan | That "not publicly launched" means an empty database |

## Sequence and boundary of this PR

First review this model and close the decisions above. Then implement in small PRs: native payment operations and refunds → order model and outcome outbox → Arrival-to-touch and promo Apply → Refref v10 adapter → isolated transport and provider E2E → authorised cutover. Details are in the [migration plan](05-migration-and-e2e.md). No Linear tasks were created.

This package is not a deployment, a legal publication, a financial activation or a public GO. **CUSTODY_IMPACT: NO** — documentation only; no credentials, host state, networks, backups or providers change. A later implementation that touches them must list custody resources per [AGENTS.md](../../AGENTS.md).
