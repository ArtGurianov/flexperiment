import type Database from "better-sqlite3";
import { id, canonicalV2, sha256 } from "./crypto";
import { rewardForOrder, REWARD_FORMULA_VERSION, type RewardOrderFacts } from "./reward-calculation";
import { getEngagement, lastActivatedEngagementRevision, occurrenceFacts } from "./agent-referrals-engagement";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { closeEngagement, type CloseEngagementResult } from "./agent-referrals-engagement-closure";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * §B-6: the reward registry `R` and its effective snapshots `E`, literally
 * two authorities (never one mutable aggregate). First finalization writes
 * immutable `R` plus `E1` (kind=INITIAL) atomically - a fault after either
 * insert rolls back both, proven by relying on nothing but the surrounding
 * db.transaction(). `R` is never rewritten; every later reward-changing
 * authoritative fact produces a new `E` row (kind=CORRECTION) instead.
 * Everything downstream (PR7's act/settlement/payment machinery) reads
 * `E`, never `R` directly - this module is the only place in the codebase
 * that reads `R.reward_total_kopecks` off the registry row itself, and
 * only to seed `E1`.
 *
 * Positive payout requires a COMPLETED occurrence (§B-6) - enforced twice
 * over, not left to chance: the migration's own CHECK
 * (`terminal_status = 'COMPLETED' OR reward_total_kopecks = 0`) is the
 * real structural backstop, and finalizeEngagementRewardRegistry below
 * additionally refuses outright (rather than letting the CHECK surface a
 * raw SQLite error) if a CANCELLED occurrence's computed total is ever
 * nonzero. The reward formula itself has no separate "CANCELLED -> force
 * zero" branch - it stays the single shared reward-calculation.ts
 * implementation - so a nonzero CANCELLED total is refused, never
 * silently clamped.
 */

export class RewardRegistryError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

type OrderFacts = RewardOrderFacts & {
  id: string;
  payment_id: string;
  payment_state: string;
  payment_status: string;
  captured_amount_kopecks: number;
  refunded_amount_kopecks: number;
  booking_status: string;
};

const ORDER_FACTS_COLUMNS = `o.id, o.attributed_agent_id, o.reward_type_snapshot, o.reward_value_snapshot,
  p.id AS payment_id, p.state AS payment_state, p.status AS payment_status, p.captured_amount_kopecks,
  COALESCE((SELECT SUM(r.amount_kopecks) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED'), 0) AS refunded_amount_kopecks,
  b.status AS booking_status`;

const engagementOrders = (db: Database.Database, engagementId: string): OrderFacts[] =>
  db.prepare(`SELECT ${ORDER_FACTS_COLUMNS} FROM orders o JOIN payments p ON p.order_id = o.id JOIN bookings b ON b.order_id = o.id
    WHERE o.resolved_engagement_id = ?`).all(engagementId) as OrderFacts[];

const ordersByIds = (db: Database.Database, orderIds: readonly string[]): OrderFacts[] =>
  orderIds.length
    ? db.prepare(`SELECT ${ORDER_FACTS_COLUMNS} FROM orders o JOIN payments p ON p.order_id = o.id JOIN bookings b ON b.order_id = o.id
        WHERE o.id IN (${orderIds.map(() => "?").join(",")})`).all(...orderIds) as OrderFacts[]
    : [];

/**
 * No UNKNOWN payment or refund outcome, no open refund obligation, no open
 * drift review - the §B-6 CANCELLED-additional gate list, applied
 * uniformly to every included order regardless of terminal_status (a
 * COMPLETED occurrence with a genuinely unresolved payment is exactly as
 * untrustworthy to finalize against).
 */
const assertOrdersReconciled = (db: Database.Database, orders: readonly OrderFacts[]): void => {
  for (const order of orders) {
    if (order.payment_state === "CREATE_UNKNOWN") throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_UNRESOLVED_PAYMENT_STATE", 409, order.id);
    if (order.payment_status === "PENDING" || order.payment_status === "RECONCILING" || order.payment_status === "REVIEW_REQUIRED") {
      throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_UNRESOLVED_PAYMENT_STATE", 409, order.id);
    }
    const openRefund = db.prepare(`SELECT id FROM refunds WHERE payment_id = ? AND status IN ('REQUESTED','SUBMITTING','SUBMIT_UNKNOWN','RECONCILING','REVIEW_REQUIRED')`).get(order.payment_id);
    if (openRefund) throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_UNRESOLVED_REFUND_STATE", 409, order.id);
    const openObligation = db.prepare(`SELECT id FROM refund_obligations WHERE payment_id = ? AND status IN ('OPEN','FULFILLING','REVIEW_REQUIRED')`).get(order.payment_id);
    if (openObligation) throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_REFUND_OBLIGATION_OPEN", 409, order.id);
    const openReview = db.prepare(`SELECT id FROM provider_drift_reviews WHERE entity_type = 'PAYMENT' AND entity_id = ? AND status = 'OPEN'`).get(order.payment_id);
    if (openReview) throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_REVIEW_OPEN", 409, order.id);
  }
};

/** Booking CANCELLED contributes 0, matching syncRewardEvidence's existing rule exactly. */
const computeRewardTotal = (orders: readonly OrderFacts[]): number =>
  orders.reduce((sum, order) => {
    if (order.booking_status !== "CONFIRMED") return sum;
    const net = Math.max(0, order.captured_amount_kopecks - order.refunded_amount_kopecks);
    return sum + rewardForOrder(order, net);
  }, 0);

const stateHash = (orders: readonly OrderFacts[]): string =>
  sha256(canonicalV2({
    orders: [...orders]
      .map((order) => ({ id: order.id, captured: order.captured_amount_kopecks, refunded: order.refunded_amount_kopecks, booking_status: order.booking_status }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }));

export type FinalizeRewardRegistryResult = { registry_snapshot_id: string; effective_snapshot_id: string; reward_total_kopecks: number; replayed: boolean };

export type EffectiveRewardSnapshotRow = {
  id: string;
  engagement_id: string;
  engagement_revision_id: string;
  base_registry_snapshot_id: string;
  supersedes_effective_snapshot_id: string | null;
  sequence: number;
  kind: "INITIAL" | "CORRECTION";
  reward_total_kopecks: number;
  source_state_hash: string;
  reason: string;
  created_by_admin_id: string;
  canonical_hash: string;
  created_at: string;
};

const EFFECTIVE_COLUMNS = "id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash, created_at";

/** "Current" is always the row with MAX(sequence) - never a mutable pointer, matching every other revision-chain table in this schema. */
export const currentEffectiveRewardSnapshot = (db: Database.Database, engagementId: string): EffectiveRewardSnapshotRow | null =>
  (db.prepare(`SELECT ${EFFECTIVE_COLUMNS} FROM engagement_effective_reward_snapshots WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1`)
    .get(engagementId) as EffectiveRewardSnapshotRow | undefined) ?? null;

/** The original INITIAL snapshot (sequence 1) - distinct from currentEffectiveRewardSnapshot, which may have moved on to a later CORRECTION. Finalization's own idempotent replay must return this one, never "whatever is current". */
const initialEffectiveRewardSnapshot = (db: Database.Database, engagementId: string): EffectiveRewardSnapshotRow | null =>
  (db.prepare(`SELECT ${EFFECTIVE_COLUMNS} FROM engagement_effective_reward_snapshots WHERE engagement_id = ? AND sequence = 1`)
    .get(engagementId) as EffectiveRewardSnapshotRow | undefined) ?? null;

export type RewardRegistrySnapshotRow = {
  id: string;
  engagement_id: string;
  engagement_revision_id: string;
  occurrence_id: string;
  terminal_status: "COMPLETED" | "CANCELLED";
  reward_total_kopecks: number;
  formula_version: number;
  source_order_ids_json: string;
  source_state_hash: string;
  watermark: string;
  finalized_by_admin_id: string;
  reason: string;
  created_at: string;
};

export const rewardRegistrySnapshot = (db: Database.Database, engagementId: string): RewardRegistrySnapshotRow | null =>
  (db.prepare(`SELECT id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason, created_at
    FROM engagement_reward_registry_snapshot WHERE engagement_id = ?`).get(engagementId) as RewardRegistrySnapshotRow | undefined) ?? null;

/**
 * Idempotent: replaying with the same engagement_id after a prior
 * successful finalization returns the ORIGINAL R/E1 pair - not
 * "whatever E is current now" (a later correction may have superseded
 * E1; finalization's own replay must still answer for the exact command
 * it was, not for the engagement's present-day payable authority - use
 * currentEffectiveRewardSnapshot for that) - rather than minting a second
 * registry or a second INITIAL snapshot. The UNIQUE(engagement_id) on
 * engagement_reward_registry_snapshot is the real structural backstop a
 * raw concurrent duplicate insert still hits, not merely this existence
 * check.
 */
export const finalizeEngagementRewardRegistry = (
  db: Database.Database,
  admin: AdminPrincipal,
  engagementId: string,
  reason: string,
): FinalizeRewardRegistryResult => {
  const run = db.transaction((): FinalizeRewardRegistryResult => {
    const existing = rewardRegistrySnapshot(db, engagementId);
    if (existing) {
      const initial = initialEffectiveRewardSnapshot(db, engagementId)!;
      return { registry_snapshot_id: existing.id, effective_snapshot_id: initial.id, reward_total_kopecks: existing.reward_total_kopecks, replayed: true };
    }

    // MATURATION_RECOVERY_REPORTING_TAIL: permitted while globally
    // SUSPENDED (§B-8 - suspension must never strand an obligation that
    // arose before it), refused only while DORMANT.
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "REWARD_REGISTRY_FINALIZATION");

    const engagement = getEngagement(db, engagementId);
    if (!engagement) throw new RewardRegistryError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
    const revision = lastActivatedEngagementRevision(db, engagementId);
    if (!revision) throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_NEVER_ACTIVATED", 409, engagementId);

    const occurrence = occurrenceFacts(db, engagement.occurrence_id)!;
    if (occurrence.fulfillment_status === "SCHEDULED") throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_OCCURRENCE_NOT_TERMINAL", 409, occurrence.fulfillment_status);
    if (occurrence.sales_status !== "CLOSED") throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_SALES_NOT_CLOSED", 409, occurrence.sales_status);

    const orders = engagementOrders(db, engagementId);
    assertOrdersReconciled(db, orders);

    const rewardTotal = computeRewardTotal(orders);
    // §B-6: a CANCELLED occurrence may finalize, but can never produce
    // positive payable authority. The migration's own CHECK is the real
    // structural backstop; this refuses with a clear code before ever
    // attempting the insert, rather than surfacing a raw CHECK failure.
    if (occurrence.fulfillment_status === "CANCELLED" && rewardTotal !== 0) {
      throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_CANCELLED_POSITIVE_REWARD_REFUSED", 409, String(rewardTotal));
    }
    const hash = stateHash(orders);
    // The instant every reconciliation gate above was proven true, inside
    // this same transaction - evidence that finalization happened against
    // a fully-resolved fact set, not an independent completeness oracle
    // beyond what assertOrdersReconciled just checked.
    const watermark = new Date().toISOString();
    const orderIds = orders.map((order) => order.id).sort();

    const registryId = id();
    db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(registryId, engagementId, revision.id, occurrence.id, occurrence.fulfillment_status, rewardTotal, REWARD_FORMULA_VERSION, JSON.stringify(orderIds), hash, watermark, admin.admin_id, reason);

    const effectiveId = id();
    const canonicalHash = sha256(canonicalV2({ registry_id: registryId, kind: "INITIAL", sequence: 1, reward_total_kopecks: rewardTotal }));
    db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
      VALUES (?, ?, ?, ?, 1, 'INITIAL', ?, ?, ?, ?, ?)`)
      .run(effectiveId, engagementId, revision.id, registryId, rewardTotal, hash, reason, admin.admin_id, canonicalHash);

    return { registry_snapshot_id: registryId, effective_snapshot_id: effectiveId, reward_total_kopecks: rewardTotal, replayed: false };
  });
  return run.immediate();
};

export type CorrectRewardResult = { effective_snapshot_id: string; reward_total_kopecks: number; sequence: number };

/**
 * Recomputes strictly over R's own pinned source_order_ids_json (never a
 * fresh query that could admit an order R never considered), re-running
 * the identical reconciliation gate finalization itself ran - a
 * reward-changing fact is only ever authoritative once every included
 * order's payment/refund/obligation/review state is resolved, exactly as
 * strict for a correction as for the first finalization. A decrease or
 * equal total (by actual state, not merely by coincidental total - see
 * the no-op refusal below) mints a new CORRECTION row; an increase is
 * refused outright - never an automatic top-up (§B-6).
 */
export const correctEngagementEffectiveRewardSnapshot = (
  db: Database.Database,
  admin: AdminPrincipal,
  engagementId: string,
  reason: string,
): CorrectRewardResult => {
  const run = db.transaction((): CorrectRewardResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "CORRECTION_LINEAGE");

    const registry = rewardRegistrySnapshot(db, engagementId);
    if (!registry) throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_NOT_FINALIZED", 409, engagementId);
    // A correction must be computed under the exact formula version R was
    // finalized under - a future formula_version bump (v2) must not
    // silently re-price an older registry's evidence via whatever
    // rewardForOrder() happens to compute today.
    if (registry.formula_version !== REWARD_FORMULA_VERSION) {
      throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_FORMULA_VERSION_UNSUPPORTED", 409, String(registry.formula_version));
    }
    const current = currentEffectiveRewardSnapshot(db, engagementId)!;

    const sourceOrderIds = JSON.parse(registry.source_order_ids_json) as string[];
    const orders = ordersByIds(db, sourceOrderIds);
    // Every order R pinned must still resolve - a source order silently
    // missing (impossible in this schema today, since orders are never
    // deleted, but defense in depth against ever misreading a shrunk set
    // as "reward decreased") is refused rather than quietly computed
    // against a smaller set than R actually considered.
    if (orders.length !== sourceOrderIds.length) {
      throw new RewardRegistryError("AGENT_REFERRALS_REWARD_REGISTRY_SOURCE_ORDER_MISSING", 409, `${orders.length}!=${sourceOrderIds.length}`);
    }
    assertOrdersReconciled(db, orders);

    const newTotal = computeRewardTotal(orders);
    const hash = stateHash(orders);

    // The state hash, not the total, is the real "did anything actually
    // change" signal: it covers exactly the facts the total is a pure
    // function of, so an unchanged hash means an unchanged total by
    // construction, and correction lineage exists to record a NEW
    // authoritative fact, not to mint an evidentially-empty replay.
    if (hash === current.source_state_hash) {
      throw new RewardRegistryError("AGENT_REFERRALS_REWARD_CORRECTION_NO_CHANGE", 409, hash);
    }
    // A correction can never itself resurrect §B-6's CANCELLED-positive-
    // reward refusal: a CANCELLED registry's E1 was already forced to 0
    // (finalizeEngagementRewardRegistry + the migration's own CHECK), and
    // "no increase over current" above already forbids any correction
    // from exceeding 0 once the chain starts there - so no separate check
    // is needed here, only structurally proven by the invariant above.
    if (newTotal > current.reward_total_kopecks) {
      throw new RewardRegistryError("AGENT_REFERRALS_REWARD_CORRECTION_INCREASE_REVIEW_REQUIRED", 409, `${current.reward_total_kopecks}->${newTotal}`);
    }

    const nextSequence = current.sequence + 1;
    const effectiveId = id();
    const canonicalHash = sha256(canonicalV2({
      registry_id: registry.id, kind: "CORRECTION", sequence: nextSequence, reward_total_kopecks: newTotal,
      source_state_hash: hash, supersedes_effective_snapshot_id: current.id,
      engagement_id: engagementId, engagement_revision_id: current.engagement_revision_id, reason,
    }));
    db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
      VALUES (?, ?, ?, ?, ?, ?, 'CORRECTION', ?, ?, ?, ?, ?)`)
      .run(effectiveId, engagementId, current.engagement_revision_id, registry.id, current.id, nextSequence, newTotal, hash, reason, admin.admin_id, canonicalHash);

    return { effective_snapshot_id: effectiveId, reward_total_kopecks: newTotal, sequence: nextSequence };
  });
  return run.immediate();
};

export type ResolveRewardRegistryFinalization = (db: Database.Database, engagementId: string) => { finalized: boolean; evidence_ref: string };

/**
 * §B-7's real production resolver: PR5 shipped closeEngagement with this
 * as a REQUIRED caller-supplied dependency precisely because no
 * engagement_reward_registry_snapshot existed yet to read (see
 * agent-referrals-engagement-closure.ts's header). Now that it does, this
 * reads the actual finalized registry - never a boolean assertion, and it
 * neither loosens nor bypasses closeEngagement's own prerequisite chain.
 */
export const resolveRewardRegistryFinalizationFromRegistry: ResolveRewardRegistryFinalization = (db, engagementId) => {
  const registry = rewardRegistrySnapshot(db, engagementId);
  return registry ? { finalized: true, evidence_ref: registry.id } : { finalized: false, evidence_ref: "" };
};

/** The real §B-7 wiring: closeEngagement, called with the production resolver above rather than a test fixture. */
export const closeEngagementWithRewardRegistry = (db: Database.Database, admin: AdminPrincipal, engagementId: string, reason: string): CloseEngagementResult =>
  closeEngagement(db, admin, engagementId, reason, resolveRewardRegistryFinalizationFromRegistry);
