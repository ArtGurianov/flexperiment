# Flexperiment Commerce V2 under Refref v10 — architecture

Status: proposal for review, 27 October 2026. Not an installed schema and not permission to open sales. Sources and SHAs are in the [entry point](README.md).

## 1. The boundary

| Object or operation | Owner after v10 | What the other side gets |
|---|---|---|
| Catalogue, offers, prices, occurrences, seats, quotes | Flexperiment | Refref gets eligible lines and service dates of a bound purchase |
| Buyer payment, refund, their evidence | Flexperiment and its own acquiring provider | Refref gets the outcome of a bound purchase; on a claim, the relevant money snapshot |
| Course access, LAB tickets, QR, playback | Flexperiment | Nothing; access is never a Refref signal |
| Receipts and fiscal corrections | Flexperiment under its qualified fiscal profile | Nothing; receipts never stand in for `PAID_IN_FULL` |
| Touch, campaign terms, `BOUND` | Refref | Flexperiment stores the durable result before opening payment |
| Commission, finality, claims | Refref | Flexperiment supplies facts and evidence |
| Partner payout transfer | Flexperiment | Refref gets the payout report and, in a dispute, relevant evidence |

Flexperiment's v1 agent referrals stay retired ([AGENTS.md](../../AGENTS.md)); referral capability lives in Refref and is not rebuilt here.

## 2. What the source does today

Audited at `c8bad757c9daa04385f9cf5e95bf6e07b185080a`. This is a source audit: databases, hosts, provider cabinets and real balances were not examined.

| Fact in the source | Where | Consequence for v10 |
|---|---|---|
| Refref is the payment rail: resolution → attempt with one `FULL` obligation → payment session → read-back → fulfilment ACK | [checkout.ts](../../commerce-v2/src/checkout.ts), [refref-payment-rail.ts](../../commerce-v2/src/refref-payment-rail.ts), [checkout protocol](../refref-checkout-protocol.md) | New v10 purchases need a Flexperiment-owned acquiring adapter; the RC.2 rail serves only its existing attempts |
| One order has one line, quantity 1; snapshot `refref.shared-checkout-snapshot/2` carries fiscal items and the payment obligation | [checkout-snapshot.ts](../../commerce-v2/src/checkout-snapshot.ts) | The v10 purchase snapshot is a different, smaller object; fiscal data stay with Flexperiment |
| Access or a ticket is granted only when the read-back shows an accepted payment of exactly the frozen total | [checkout.ts](../../commerce-v2/src/checkout.ts) `applyRailProjection` | Keep the rule, with the native provider as the payment truth |
| Refunds are full-only, executed through Refref; access ends only after an accepted refund | [refunds.ts](../../commerce-v2/src/refunds.ts), [refund-envelope.ts](../../commerce-v2/src/refund-envelope.ts) | Refunds move to the native provider; the "access ends only on a proven refund" rule stays |
| Arrival (ADR-139): per-storefront context cookie (`__Host-flx-ctx-lms`, `__Host-flx-ctx-lab`, 30-day default Max-Age), proof kept in SQLite up to 30 minutes, Buy waits ≤ 1,500 ms and freezes `deliveryDegraded` | [browser-context.ts](../../commerce-v2/src/browser-context.ts), [0034](../../commerce-v2/migrations/0034_browser_contexts.sql) | Replaced by v10 touch and holder rules; `deliveryDegraded` must not open payment for a referral path |
| One code field: codes with the merchant prefix are Flexperiment promotions; any other code is sent to Refref | [promotions.ts](../../commerce-v2/src/promotions.ts), [CheckoutFlow.tsx](../../apps/lab/components/CheckoutFlow.tsx) | Keep the namespaces; add v10 Apply semantics for Refref codes |
| Quote and intent live at most 15 minutes and never past the LAB start | [checkout.ts](../../commerce-v2/src/checkout.ts) `intentDeadline` | Keep; `BOUND` must exist before the payment session is created |
| LAB seats are released only by a final order outcome; schedule and venue are frozen once a seat is committed | [lab-occurrences.ts](../../commerce-v2/src/lab-occurrences.ts) | Keep; occurrence moves and cancellations need the S5 rules in [profiles](02-lms-and-lab-profiles.md) |
| Fiscal semantics come from a qualified, versioned policy per offer, frozen into the order line | [fiscal-policy.ts](../../commerce-v2/src/fiscal-policy.ts) | Keep as the source of receipt semantics for the native profile |
| SQLite (`better-sqlite3`) with a migration lock | [migrations](../../commerce-v2/migrations/), [db.ts](../../commerce-v2/src/db.ts) | New tables are forward migrations after `0035`; applied files never change |

## 3. Options considered

| Option | Decision | Reason |
|---|---|---|
| Keep the Refref payment rail and report outcomes from it | Rejected | v10 has no Refref-owned payment; Refref would keep acting as payment intermediary |
| Rewrite orders and attempts in place for the new provider | Rejected | Destroys evidence of accepted orders and breaks recovery of open RC.2 attempts |
| New native payment operations next to the existing order, an outcome outbox and a v10 adapter | Proposed | Keeps one order identity, isolates old attempts and gives Refref only what v10 needs |

## 4. Minimal domain changes

| Entity | Content | Invariant |
|---|---|---|
| Purchase identity | Stable `purchaseRef` (the existing order public id is a candidate), product kind, link to `BOUND` or to the decision that the sale is ordinary | One economic purchase → at most one `BOUND` and one `C` |
| Payment operation | Native provider, account, operation id, amount in kopecks, idempotency key, observed outcome and times | `UNKNOWN` is not failure; no second instruction for an unpaid amount while an earlier one may still succeed |
| Refund operation | Provider refund id, amount, link to payment and line, outcome and times | A refund is done only when the provider confirms it; access and tickets follow that fact |
| Referral record | `touchRef`, holder version, `bindingRef`, command ids, the result of the binding command | The payment gate opens only after a durable `BOUND` or an explicit ordinary-sale decision |
| Outcome outbox | `PAID_IN_FULL`, `NOT_PAID`, `CANCELLED` for bound purchases, with actual times and the effective revision | Written in the same transaction as the local business fact; retries resend the same command |
| Payout obligations | Monthly registry lines received from Refref, transfer facts, reports | Separate from buyer payments; never paid twice for an `UNKNOWN` transfer |

States stay orthogonal: order, payment operation, refund, access or ticket, fiscal document, referral binding, outcome delivery. A failed Refref delivery never turns a paid order into an unpaid one or creates a second payment session.

## 5. Normal path

```mermaid
sequenceDiagram
    participant B as Buyer
    participant F as Flexperiment
    participant R as Refref v10
    participant P as Flexperiment acquiring
    B->>F: Choose offer, see quote (optional Apply of a Refref code)
    F->>R: Create BOUND before any payment session
    R-->>F: Durable BOUND (or refusal); lost answer read back by command id
    F->>P: Create payment for the frozen total
    P-->>F: Confirmed payment (read-back)
    F->>F: Grant access or issue ticket; receipt by fiscal profile; outbox PAID_IN_FULL
    F->>R: PAID_IN_FULL with actual time and purchase snapshot
    R-->>F: Receipt; one C; FINAL later under the product's finality mode
```

A purchase without a touch is an ordinary sale with no report to Refref. If a binding command was sent and its result is unknown, the payment gate stays closed until the result is read back; the sale must not continue on the referral path and must not silently drop a promised price.

## 6. Operations

The normal flow is automatic: provider read-back → local fact → outbox → Refref receipt. Operators see only exceptions: unknown payment or refund outcomes, failed fiscal documents, a stuck outbox, a payout dispute. Logs and monitoring carry opaque ids only; no buyer email, account or card data goes to Refref.
