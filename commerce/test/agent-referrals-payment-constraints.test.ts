import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptedAct, activeNpdCheck, admin, finalizedSettlement, fresh, nearTermTerms,
  offerAcceptActivate, purchaseAndPay, readyPartner, seedOccurrence,
} from "./support/agent-referrals-settlement-fixtures";
import { beginPayment, recordConfirmedNotMade, recordPaymentMade, recordPayoutUnknown } from "../src/agent-referrals-payment";
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

/** Everything a payment needs, stopping short of beginning one. */
const preparedForPayment = (db: Database.Database, domain: CommerceDomain, taxMode: "NPD" | "OTHER" = "OTHER") => {
  const partner = readyPartner(db, taxMode);
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
  const order = purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
  const settlement = finalizedSettlement(db, domain, occurrenceId, engagementId);
  acceptedAct(db, partner.partner, settlement);
  if (taxMode === "NPD") activeNpdCheck(db, partner.partnerIdentityId);
  return { partner, occurrenceId, engagementId, settlement, order };
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

  it("freezes an attempt confirmed as not made, as firmly as one that was", () => {
    // The guard has two terminal branches and this is the other one. A
    // confirmed non-payment is as settled a fact as a payment.
    const { db, domain } = setup();
    const { settlement } = preparedForPayment(db, domain);
    const begun = beginPayment(db, admin, settlement.id);
    recordConfirmedNotMade(db, admin, begun.attempt.id, "bank returned it");

    expect(() => db.prepare("UPDATE payment_attempts SET evidence_ref = 'rewritten' WHERE id = ?").run(begun.attempt.id))
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
    const order = purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occurrenceId, engagementId);
    acceptedAct(db, partner.partner, settlement);
    if (taxMode === "NPD") activeNpdCheck(db, partner.partnerIdentityId);
    return { partner, settlement, engagementId, order };
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

  it.each(["IN_PROGRESS", "PAYOUT_UNKNOWN"] as const)("refuses to supersede a settlement whose payment is %s", (attemptStatus) => {
    // Cancelling a settlement beside a payment that may have left is how a
    // partner is paid for something the ledger says was abandoned.
    //
    // The refusal arrives earlier than expected, and that is the finding. The
    // transition guard also names the in-flight statuses, but its branch
    // additionally requires a correction that supersedes this settlement's
    // snapshot - and the schema will not let that correction be written while
    // a payout is in flight, by the domain or by direct SQL. So the two can
    // never coexist, and the transition guard's in-flight term is defence in
    // depth behind this one.
    const { db, domain } = setup();
    const { settlement, engagementId, order } = preparedWithoutPayment(db, domain, "OTHER");
    const begun = beginPayment(db, admin, settlement.id);
    if (attemptStatus === "PAYOUT_UNKNOWN") recordPayoutUnknown(db, admin, begun.attempt.id, "provider timed out");
    expect(query<{ status: string }>(db, "SELECT status FROM payment_attempts WHERE id = ?", begun.attempt.id).status).toBe(attemptStatus);

    // The correction is built directly, because the domain refuses to mint one
    // while a payout is in flight. That refusal is the first line; this guard
    // is the second, and the only way to reach it is the way it exists for -
    // someone writing to the database without going through the domain.
    const current = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE id = ?", String(settlement.effective_reward_snapshot_id));
    const correction = { ...current, id: randomUUID(), sequence: Number(current.sequence) + 1, kind: "CORRECTION",
      supersedes_effective_snapshot_id: current.id, reward_total_kopecks: 1_000, canonical_hash: `canon-${randomUUID()}` };
    const columns = Object.keys(correction);
    void engagementId; void order;

    expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(${columns.join(", ")})
      VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(correction))
      .toThrow(/AGENT_REFERRALS_CORRECTION_BLOCKED_PAYMENT_IN_FLIGHT/);
    expect(query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", settlement.id).status).toBe("PREPARED");
  });

  it("has already left PREPARED by the time a payment is made", () => {
    // The guard's cancellation branch also names MADE, and that term has no
    // independently reachable case: recording a payment advances the
    // settlement in the same act, so a PREPARED settlement and a MADE attempt
    // never coexist. What refuses the cancellation then is the terminal guard,
    // one step further on. The term is defence in depth against a path that
    // would have to bypass `recordPaymentMade` to exist.
    const { db, domain } = setup();
    const { settlement } = preparedWithoutPayment(db, domain, "OTHER");
    const begun = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, begun.attempt.id, "bank-evidence");

    expect(query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", settlement.id).status).toBe("SETTLED");
    expect(() => db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION' WHERE id = ?").run(settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TERMINAL_IMMUTABLE/);
  });

  it("permits cancellation once the payment is resolved as not made", () => {
    // The positive control the three refusals need: a confirmed non-payment is
    // not an unresolved one, so a genuine correction may supersede the
    // settlement. Without this the guard could simply forbid all cancellation
    // and the cases above would still pass.
    const { db, domain } = setup();
    const { settlement, engagementId, order } = preparedWithoutPayment(db, domain, "OTHER");
    const begun = beginPayment(db, admin, settlement.id);
    recordConfirmedNotMade(db, admin, begun.attempt.id, "bank returned it");

    db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status,
      idempotency_key_hash, canonical_request_hash, succeeded_at)
      VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))`)
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund", String(settlement.effective_reward_snapshot_id));

    expect(query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", settlement.id).status)
      .toBe("CANCELLED_BEFORE_PAYMENT");
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
    return { engagementId, effective, closure, occurrenceId };
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

  it.each([
    ["a snapshot belonging to another engagement", "effective_reward_snapshot_id"],
    ["a revision the snapshot does not name", "engagement_revision_id"],
    ["a registry the snapshot is not based on", "base_registry_snapshot_id"],
  ] as const)("refuses a closure citing %s", (_label, column) => {
    // Each pin is checked separately, against a real row of a second engagement
    // that also earned nothing - so the foreign key is satisfied and only the
    // relational predicate can refuse it.
    const { db } = setup();
    const first = zeroRewarded(db);
    const second = zeroRewarded(db);
    const wrong = column === "effective_reward_snapshot_id" ? second.effective.id : second.effective[column];
    expect(wrong).not.toEqual(first.closure[column]);

    expect(insertVariant(db, "engagement_zero_reward_closures", first.closure, { [column]: wrong }))
      .toThrow(/ENGAGEMENT_ZERO_REWARD_CLOSURE_RELATIONAL_INCONSISTENT/);
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

  it("refuses exposure for a settlement whose payment was never made", () => {
    // Exposure is the amount a partner has to give back. Without a payment
    // there is nothing to give back, and the row would assert a debt that
    // never arose.
    const { db, domain } = setup();
    const { engagementId } = exposed(db, domain);
    const evidence = rowOf(db, "SELECT * FROM engagement_recovery_exposure_evidence WHERE engagement_id = ?", engagementId);

    // A second engagement corrected while its settlement was never paid: the
    // settlement and the correction both exist and belong together, so only
    // the payment predicate is unsatisfied.
    const unpaid = preparedForPayment(db, domain, "OTHER");
    // An attempt exists and resolved as not made, so the correction is
    // permitted and the guard's payment predicate is the only one left
    // unsatisfied.
    const attempt = beginPayment(db, admin, unpaid.settlement.id);
    recordConfirmedNotMade(db, admin, attempt.attempt.id, "bank returned it");
    db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status,
      idempotency_key_hash, canonical_request_hash, succeeded_at)
      VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))`)
      .run(randomUUID(), randomUUID(), unpaid.order.id, unpaid.order.payment_id, randomUUID());
    correctPartnerRewardWithSettlement(db, admin, unpaid.engagementId, "late refund", String(unpaid.settlement.effective_reward_snapshot_id));
    const correction = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? AND kind = 'CORRECTION' LIMIT 1", unpaid.engagementId);

    expect(insertVariant(db, "engagement_recovery_exposure_evidence", evidence, {
      engagement_id: unpaid.engagementId, settlement_id: unpaid.settlement.id, effective_reward_snapshot_id: correction.id,
    })).toThrow(/ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_RELATIONAL_INCONSISTENT/);
  });

  it("refuses exposure citing another engagement's correction", () => {
    const { db, domain } = setup();
    const first = exposed(db, domain);
    const second = exposed(db, domain);
    const evidence = rowOf(db, "SELECT * FROM engagement_recovery_exposure_evidence WHERE engagement_id = ?", first.engagementId);
    const foreignCorrection = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? AND kind = 'CORRECTION' LIMIT 1", second.engagementId);

    expect(insertVariant(db, "engagement_recovery_exposure_evidence", evidence, { effective_reward_snapshot_id: foreignCorrection.id }))
      .toThrow(/ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_RELATIONAL_INCONSISTENT/);
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
