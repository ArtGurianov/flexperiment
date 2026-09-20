import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptedAct, activeNpdCheck, admin, finalizedSettlement, fresh, nearTermTerms,
  offerAcceptActivate, purchaseAndPay, readyPartner, seedOccurrence,
} from "./support/agent-referrals-settlement-fixtures";
import { beginPayment, recordPaymentMade } from "../src/agent-referrals-payment";
import { finalizeEngagementRewardRegistry } from "../src/agent-referrals-reward-registry";
import { correctPartnerRewardWithSettlement } from "../src/agent-referrals-settlement";
import type { CommerceDomain } from "../src/domain";

/**
 * Constraints of the live schema around paying a partner: the authorization
 * that permits a payment, the attempt that records one, the receipt that
 * evidences it under the NPD regime, and the exposure a later correction
 * creates when the money has already gone.
 *
 * These are the rows that say a real person was paid a real amount. As
 * elsewhere, they are produced by the domain, each guard is covered by its
 * branches, and each is read in the schema the migrations actually produce
 * rather than in the migration that first introduced it.
 */
const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()?.close(); });

const query = <T>(db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).get(...args) as T;
const rowOf = (db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  query<Record<string, unknown>>(db, sql, ...args);

const insertVariant = (db: Database.Database, table: string, source: Record<string, unknown>, changes: Record<string, unknown>) => {
  const next = { ...source, ...changes, id: randomUUID() };
  const columns = Object.keys(next);
  return () => db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(next);
};

const setup = () => {
  const { db, domain } = fresh();
  open.push(db);
  return { db, domain: domain as CommerceDomain };
};

/** A partner paid all the way through: settlement, accepted act, authorization, attempt MADE. */
const paid = (db: Database.Database, domain: CommerceDomain, taxMode: "NPD" | "OTHER" = "NPD") => {
  const partner = readyPartner(db, taxMode);
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
  const order = purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
  const settlement = finalizedSettlement(db, domain, occurrenceId, engagementId);
  acceptedAct(db, partner.partner, settlement);
  if (taxMode === "NPD") activeNpdCheck(db, partner.partnerIdentityId);
  const begun = beginPayment(db, admin, settlement.id);
  recordPaymentMade(db, admin, begun.attempt.id, "bank-evidence-1");
  return { partner, occurrenceId, engagementId, settlement, order, authorizationId: begun.authorization.id, attemptId: begun.attempt.id };
};

describe("a payment authorization is the permission that was granted", () => {
  it("cannot be edited or deleted once it exists", () => {
    // It names the act the partner accepted, the payout destination and the
    // NPD status that made the payment lawful. Editing it afterwards changes
    // what the payment was permitted to be.
    const { db, domain } = setup();
    const { authorizationId } = paid(db, domain);

    expect(() => db.prepare("UPDATE payment_authorizations SET amount_kopecks = 1 WHERE id = ?").run(authorizationId))
      .toThrow(/PAYMENT_AUTHORIZATION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM payment_authorizations WHERE id = ?").run(authorizationId))
      .toThrow(/PAYMENT_AUTHORIZATION_IMMUTABLE/);
  });
});

describe("a payment attempt is the record that money moved", () => {
  it("cannot be deleted, settled or unsettled", () => {
    const { db, domain } = setup();
    const { attemptId } = paid(db, domain);
    expect(query<{ status: string }>(db, "SELECT status FROM payment_attempts WHERE id = ?", attemptId).status).toBe("MADE");

    expect(() => db.prepare("DELETE FROM payment_attempts WHERE id = ?").run(attemptId))
      .toThrow(/PAYMENT_ATTEMPT_IMMUTABLE/);
    // Walking the status back is refused one guard earlier, by the transition
    // rule; the terminal guard is what refuses everything else.
    expect(() => db.prepare("UPDATE payment_attempts SET status = 'IN_PROGRESS' WHERE id = ?").run(attemptId))
      .toThrow(/PAYMENT_ATTEMPT_TRANSITION_ILLEGAL|PAYMENT_ATTEMPT_TERMINAL_IMMUTABLE/);
    expect(() => db.prepare("UPDATE payment_attempts SET evidence_ref = 'rewritten' WHERE id = ?").run(attemptId))
      .toThrow(/PAYMENT_ATTEMPT_TERMINAL_IMMUTABLE/);
  });

  it.each([
    ["an authorization that permits a different settlement", "settlement_id"],
    ["an amount the authorization did not permit", "amount_kopecks"],
  ])("refuses an attempt naming %s", (_label, column) => {
    // The authorization is the whole permission. An attempt that does not
    // restate it is a payment nobody approved at that amount.
    const { db, domain } = setup();
    const { attemptId } = paid(db, domain);
    const attempt = rowOf(db, "SELECT * FROM payment_attempts WHERE id = ?", attemptId);
    const second = paid(db, domain);
    const other = rowOf(db, "SELECT * FROM payment_attempts WHERE id = ?", second.attemptId);

    expect(insertVariant(db, "payment_attempts", attempt, { status: "IN_PROGRESS", [column]: column === "amount_kopecks" ? 1 : other[column] }))
      .toThrow(/PAYMENT_ATTEMPT_RELATIONAL_INCONSISTENT/);
  });
});

describe("an NPD receipt evidences a payment that was actually made", () => {
  it("cannot be edited or deleted", () => {
    const { db, domain } = setup();
    const { settlement, attemptId } = paid(db, domain);
    const receipt = { id: randomUUID(), payment_attempt_id: attemptId, settlement_id: settlement.id, receipt_reference: "fns-1", evidence_ref: "ev-1", created_by_admin_id: admin.admin_id };
    db.prepare(`INSERT INTO npd_receipts(id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id)
      VALUES (@id, @payment_attempt_id, @settlement_id, @receipt_reference, @evidence_ref, @created_by_admin_id)`).run(receipt);

    expect(() => db.prepare("UPDATE npd_receipts SET receipt_reference = 'rewritten' WHERE id = ?").run(receipt.id))
      .toThrow(/NPD_RECEIPT_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM npd_receipts WHERE id = ?").run(receipt.id))
      .toThrow(/NPD_RECEIPT_IMMUTABLE/);
  });

  it("refuses a receipt for a payment that was not made", () => {
    // A receipt is a claim to the tax authority that money changed hands.
    const { db, domain } = setup();
    const { settlement, partner } = paid(db, domain);
    // A second settlement whose payment has begun but not completed.
    const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
    const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
    purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
    const second = finalizedSettlement(db, domain, occurrenceId, engagementId);
    acceptedAct(db, partner.partner, second);
    const begun = beginPayment(db, admin, second.id);
    expect(query<{ status: string }>(db, "SELECT status FROM payment_attempts WHERE id = ?", begun.attempt.id).status).toBe("IN_PROGRESS");

    const receipt = { id: randomUUID(), payment_attempt_id: begun.attempt.id, settlement_id: second.id, receipt_reference: "fns-2", evidence_ref: "ev-2", created_by_admin_id: admin.admin_id };
    expect(insertVariant(db, "npd_receipts", receipt, {})).toThrow(/NPD_RECEIPT_RELATIONAL_INCONSISTENT/);
    void settlement;
  });

  it("refuses a receipt naming a settlement the attempt does not belong to", () => {
    const { db, domain } = setup();
    const first = paid(db, domain);
    const second = paid(db, domain);
    const receipt = { id: randomUUID(), payment_attempt_id: first.attemptId, settlement_id: second.settlement.id, receipt_reference: "fns-3", evidence_ref: "ev-3", created_by_admin_id: admin.admin_id };
    expect(insertVariant(db, "npd_receipts", receipt, {})).toThrow(/NPD_RECEIPT_RELATIONAL_INCONSISTENT/);
  });

  it("refuses a receipt for a settlement that is not under the NPD regime", () => {
    // The receipt only means anything for a self-employed payee.
    const { db, domain } = setup();
    const other = paid(db, domain, "OTHER");
    const receipt = { id: randomUUID(), payment_attempt_id: other.attemptId, settlement_id: other.settlement.id, receipt_reference: "fns-4", evidence_ref: "ev-4", created_by_admin_id: admin.admin_id };
    expect(insertVariant(db, "npd_receipts", receipt, {})).toThrow(/NPD_RECEIPT_RELATIONAL_INCONSISTENT/);
  });

  it("freezes the status check the authorization relied on", () => {
    const { db, domain } = setup();
    const { partner } = paid(db, domain);
    const check = rowOf(db, "SELECT * FROM npd_status_checks WHERE partner_identity_id = ? ORDER BY sequence DESC LIMIT 1", partner.partnerIdentityId);

    expect(() => db.prepare("UPDATE npd_status_checks SET status = 'INACTIVE' WHERE id = ?").run(check.id))
      .toThrow(/NPD_STATUS_CHECK_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM npd_status_checks WHERE id = ?").run(check.id))
      .toThrow(/NPD_STATUS_CHECK_IMMUTABLE/);
  });
});

describe("a settlement's status follows what the payment actually did", () => {
  // The transition guard is where the settlement state machine and the payment
  // state machine meet, and every branch of it is a claim about money. These
  // are the branches, driven by real attempts rather than by UPDATEs chosen to
  // make a trigger fire.
  const preparedWithoutPayment = (db: Database.Database, domain: CommerceDomain, taxMode: "NPD" | "OTHER") => {
    const partner = readyPartner(db, taxMode);
    const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
    const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
    purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occurrenceId, engagementId);
    acceptedAct(db, partner.partner, settlement);
    if (taxMode === "NPD") activeNpdCheck(db, partner.partnerIdentityId);
    return { partner, settlement, engagementId };
  };

  it.each(["OTHER", "NPD"] as const)("refuses to settle a %s partner before a payment was made", (taxMode) => {
    const { db, domain } = setup();
    const { settlement } = preparedWithoutPayment(db, domain, taxMode);
    const next = taxMode === "OTHER" ? "SETTLED" : "PENDING_DOCUMENT";

    expect(() => db.prepare(`UPDATE reward_settlements SET status = '${next}' WHERE id = ?`).run(settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TRANSITION_ILLEGAL/);

    // The same transition is permitted once an attempt actually reports MADE.
    const begun = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, begun.attempt.id, "bank-evidence");
    expect(query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", settlement.id).status).toBe(next);
  });

  it("refuses to close an NPD settlement before its receipt exists", () => {
    // PENDING_DOCUMENT is exactly the state of "paid, but the receipt the tax
    // regime requires has not been produced".
    const { db, domain } = setup();
    const context = paid(db, domain, "NPD");
    expect(query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", context.settlement.id).status).toBe("PENDING_DOCUMENT");

    expect(() => db.prepare("UPDATE reward_settlements SET status = 'SETTLED' WHERE id = ?").run(context.settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TRANSITION_ILLEGAL/);

    db.prepare(`INSERT INTO npd_receipts(id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id)
      VALUES (?, ?, ?, 'fns-settle', 'ev-settle', ?)`).run(randomUUID(), context.attemptId, context.settlement.id, admin.admin_id);
    expect(() => db.prepare("UPDATE reward_settlements SET status = 'SETTLED' WHERE id = ?").run(context.settlement.id)).not.toThrow();
  });

  it("refuses to cancel a settlement whose payment is in flight or already made", () => {
    // Cancelling a settlement beside a live payment is how a partner is paid
    // for something the ledger says was abandoned.
    const { db, domain } = setup();
    const { settlement } = preparedWithoutPayment(db, domain, "OTHER");
    const begun = beginPayment(db, admin, settlement.id);
    expect(query<{ status: string }>(db, "SELECT status FROM payment_attempts WHERE id = ?", begun.attempt.id).status).toBe("IN_PROGRESS");

    expect(() => db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION' WHERE id = ?").run(settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TRANSITION_ILLEGAL/);
  });

  it("freezes a settlement that reached SETTLED", () => {
    // The other terminal state, and it has to be as final as cancellation.
    const { db, domain } = setup();
    const context = paid(db, domain, "OTHER");
    expect(query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", context.settlement.id).status).toBe("SETTLED");

    expect(() => db.prepare("UPDATE reward_settlements SET settled_at = '2030-01-01T00:00:00Z' WHERE id = ?").run(context.settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TERMINAL_IMMUTABLE/);
  });
});

describe("a zero-reward closure records an engagement that earned nothing", () => {
  /** A cancelled occurrence: the registry finalizes, and the reward is zero. */
  const zeroRewarded = (db: Database.Database) => {
    const partner = readyPartner(db, "OTHER");
    const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
    db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', sales_status = 'CLOSED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'test' WHERE id = ?").run(occurrenceId);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence cancelled");
    const effective = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE id = ?", finalize.effective_snapshot_id);
    expect(effective.reward_total_kopecks).toBe(0);
    const closure = {
      id: randomUUID(), engagement_id: engagementId, engagement_revision_id: effective.engagement_revision_id,
      base_registry_snapshot_id: effective.base_registry_snapshot_id, effective_reward_snapshot_id: effective.id,
      reward_total_kopecks: 0, closure_reason: "OCCURRENCE_CANCELLED", occurrence_fulfillment_status: "CANCELLED",
      service_period_start_at: "2026-09-01T00:00:00.000Z", service_period_end_at: "2026-09-30T00:00:00.000Z",
      reporting_policy_version: 1, command_id: randomUUID(), canonical_hash: "canon-z", closed_by_admin_id: admin.admin_id,
    };
    return { engagementId, effective, closure, partner, occurrenceId };
  };

  it("is accepted for an engagement that earned nothing and was never settled", () => {
    const { db } = setup();
    const { closure } = zeroRewarded(db);
    expect(insertVariant(db, "engagement_zero_reward_closures", closure, {})).not.toThrow();
  });

  it("cannot be edited or deleted once recorded", () => {
    const { db } = setup();
    const { closure } = zeroRewarded(db);
    const columns = Object.keys(closure);
    db.prepare(`INSERT INTO engagement_zero_reward_closures(${columns.join(", ")})
      VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(closure);

    expect(() => db.prepare("UPDATE engagement_zero_reward_closures SET closure_reason = 'rewritten' WHERE id = ?").run(closure.id))
      .toThrow(/ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM engagement_zero_reward_closures WHERE id = ?").run(closure.id))
      .toThrow(/ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE/);
  });

  it("refuses a closure for an engagement that did earn something", () => {
    // Closing at zero is a statement that nothing is owed. It has to be true.
    const { db, domain } = setup();
    const { closure } = zeroRewarded(db);
    const earning = paid(db, domain, "OTHER");
    const earned = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1", earning.engagementId);

    expect(insertVariant(db, "engagement_zero_reward_closures", closure, {
      engagement_id: earning.engagementId, engagement_revision_id: earned.engagement_revision_id,
      base_registry_snapshot_id: earned.base_registry_snapshot_id, effective_reward_snapshot_id: earned.id,
    })).toThrow(/ENGAGEMENT_ZERO_REWARD_CLOSURE_RELATIONAL_INCONSISTENT/);
  });

  // Note: the guard's third branch - no live settlement may exist for the
  // engagement - has no independently reachable case here. A settlement is only
  // ever created for a snapshot that earned something, and the settlement
  // guards themselves refuse a hand-built one; so an engagement can have a zero
  // reward or a live settlement, not both. It is defence in depth against a
  // future path that could produce one, and that is recorded rather than
  // asserted by a case that would have to forge a settlement to exist.
});

describe("a correction after payment records what is now owed back", () => {
  const exposed = (db: Database.Database, domain: CommerceDomain) => {
    const context = paid(db, domain);
    db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status,
      idempotency_key_hash, canonical_request_hash, succeeded_at)
      VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))`)
      .run(randomUUID(), randomUUID(), context.order.id, context.order.payment_id, randomUUID());
    correctPartnerRewardWithSettlement(db, admin, context.engagementId, "late refund after payment", String(context.settlement.effective_reward_snapshot_id));
    return context;
  };

  it("cannot be edited or deleted", () => {
    // It is the record that a partner was paid more than they turned out to be
    // owed. Erasing it erases the obligation.
    const { db, domain } = setup();
    const { engagementId } = exposed(db, domain);
    const evidence = rowOf(db, "SELECT * FROM engagement_recovery_exposure_evidence WHERE engagement_id = ?", engagementId);
    expect(evidence).toBeTruthy();

    expect(() => db.prepare("UPDATE engagement_recovery_exposure_evidence SET exposure_kopecks = 0 WHERE id = ?").run(evidence.id))
      .toThrow(/ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM engagement_recovery_exposure_evidence WHERE id = ?").run(evidence.id))
      .toThrow(/ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_IMMUTABLE/);
  });

  it.each(["FOREIGN_SETTLEMENT", "NOT_A_CORRECTION"] as const)("refuses exposure naming %s", (variant) => {
    const { db, domain } = setup();
    const { engagementId } = exposed(db, domain);
    const evidence = rowOf(db, "SELECT * FROM engagement_recovery_exposure_evidence WHERE engagement_id = ?", engagementId);
    const changes = variant === "FOREIGN_SETTLEMENT"
      // A settlement belonging to a different engagement entirely.
      ? { settlement_id: paid(db, domain).settlement.id }
      // The engagement's own first snapshot, which is not a correction: exposure
      // only arises from one.
      : { effective_reward_snapshot_id: rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? AND kind = 'INITIAL'", engagementId).id };

    expect(insertVariant(db, "engagement_recovery_exposure_evidence", evidence, changes))
      .toThrow(/ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_RELATIONAL_INCONSISTENT/);
  });
});
