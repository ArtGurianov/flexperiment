import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptedAct, admin, closeAndComplete, finalizedSettlement, fresh, nearTermTerms, offerAcceptActivate, purchaseAndPay, readyPartner, seedOccurrence,
} from "./support/agent-referrals-settlement-fixtures";
import { finalizeEngagementRewardRegistry } from "../src/agent-referrals-reward-registry";
import { generateSettlementAct } from "../src/agent-referrals-act";
import { correctPartnerRewardWithSettlement } from "../src/agent-referrals-settlement";
import type { CommerceDomain } from "../src/domain";

/**
 * Constraints of the live schema that protect a partner settlement and the act
 * it is paid against. They were asserted only inside the test for the migration
 * that introduced them.
 *
 * As with attribution, the rows are the ones the domain writes: a settlement
 * prepared from a finalized reward snapshot, an act generated, presented and
 * accepted through the real step-up chain. And as there, each guard is covered
 * by its branches - a guard freezing fifteen columns is not carried across by a
 * test that edits three.
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

type Partner = ReturnType<typeof readyPartner>;

/**
 * A second engagement for the same partner, finalized but never settled.
 *
 * INSERT-time guards are otherwise unreachable: one settlement per effective
 * snapshot, one act per settlement, so re-inserting a copy of a real row trips
 * the unique index long before the guard has an opinion. Varying a row built
 * for an engagement that has no settlement yet is what puts the guard first.
 */
const unsettledEngagement = (db: Database.Database, domain: CommerceDomain, partner: Partner) => {
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
  purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
  closeAndComplete(db, domain, occurrenceId);
  const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");
  const effective = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE id = ?", finalize.effective_snapshot_id);
  const registry = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", engagementId);
  return { occurrenceId, engagementId, effective, registry };
};

/** A settlement row for that engagement, valid unless a field is varied. */
const settlementTemplate = (template: Record<string, unknown>, target: ReturnType<typeof unsettledEngagement>): Record<string, unknown> => ({
  ...template,
  engagement_id: target.engagementId,
  occurrence_id: target.occurrenceId,
  engagement_revision_id: target.effective.engagement_revision_id,
  base_registry_snapshot_id: target.registry.id,
  reward_registry_hash: target.registry.source_state_hash,
  effective_reward_snapshot_id: target.effective.id,
  amount_kopecks: target.effective.reward_total_kopecks,
  supersedes_settlement_id: null,
});

/** A real partner settlement, prepared from a finalized reward snapshot. */
const settled = (db: Database.Database, domain: CommerceDomain, existing?: Partner) => {
  const partner = existing ?? readyPartner(db, "OTHER");
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
  const order = purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
  const settlement = finalizedSettlement(db, domain, occurrenceId, engagementId);
  return { partner, occurrenceId, engagementId, settlement, order };
};

describe("a settlement's authority cannot be rewritten", () => {
  // Every column the guard freezes. Each one is part of why this settlement is
  // owed to this partner for this engagement at this amount; editing one after
  // the fact detaches the payout from the work that justified it.
  it.each([
    "engagement_id = NULL",
    "tax_treatment_revision_id_snapshot = NULL",
    "tax_canonicalization_version = 'rewritten'",
    "tax_canonical_json = 'rewritten'",
    "tax_canonical_hash = 'rewritten'",
    "engagement_revision_id = NULL",
    "base_registry_snapshot_id = NULL",
    "reward_registry_hash = 'rewritten'",
    "effective_reward_snapshot_id = NULL",
    "partner_identity_id = NULL",
    "payout_profile_revision_id = NULL",
    "tax_mode_snapshot = 'NPD'",
    "legal_profile_revision_id_snapshot = NULL",
    "supersedes_settlement_id = 'someone-else'",
    "amount_kopecks = 1",
    "occurrence_id = NULL",
    "agent_id = NULL",
    "contractor_type_snapshot = 'INDIVIDUAL'",
  ])("refuses to change %s", (assignment) => {
    const { db, domain } = setup();
    const { settlement } = settled(db, domain);
    expect(() => db.prepare(`UPDATE reward_settlements SET ${assignment} WHERE id = ?`).run(settlement.id))
      .toThrow(/REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE/);
  });
});

describe("a settlement's authority tuple has to hold together", () => {
  it.each([
    ["no engagement", { engagement_id: null }],
    ["no revision", { engagement_revision_id: null }],
    ["no base registry", { base_registry_snapshot_id: null }],
    ["no registry hash", { reward_registry_hash: null }],
    ["no effective snapshot", { effective_reward_snapshot_id: null }],
    ["no partner identity", { partner_identity_id: null }],
    ["no payout profile revision", { payout_profile_revision_id: null }],
    ["no tax mode", { tax_mode_snapshot: null }],
    ["no legal profile revision", { legal_profile_revision_id_snapshot: null }],
    ["an amount the effective snapshot does not carry", { amount_kopecks: 4_999 }],
    ["a registry hash the base registry does not carry", { reward_registry_hash: "not-the-hash" }],
  ])("refuses a settlement with %s", (_label, changes) => {
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const target = unsettledEngagement(db, domain, partner);
    const template = settlementTemplate(rowOf(db, "SELECT * FROM reward_settlements WHERE id = ?", settlement.id), target);

    // The template itself is accepted, so each case is about its one change.
    expect(insertVariant(db, "reward_settlements", template, changes))
      .toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
  });

  it("accepts the template every one of those cases varies", () => {
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const target = unsettledEngagement(db, domain, partner);
    const template = settlementTemplate(rowOf(db, "SELECT * FROM reward_settlements WHERE id = ?", settlement.id), target);
    expect(insertVariant(db, "reward_settlements", template, {})).not.toThrow();
  });

  it("refuses a settlement for an occurrence that has not completed", () => {
    // Payable authority begins when the occurrence terminated, not when a
    // reward was computed.
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const target = unsettledEngagement(db, domain, partner);
    const template = settlementTemplate(rowOf(db, "SELECT * FROM reward_settlements WHERE id = ?", settlement.id), target);
    const openOccurrence = seedOccurrence(db, partner.cityId, 100_000);

    expect(insertVariant(db, "reward_settlements", template, { occurrence_id: openOccurrence }))
      .toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
  });

  // Note: `AGENT_REFERRALS_SETTLEMENT_CONTRACTOR_TYPE_PROJECTION_MISMATCH` has
  // no independently reachable branch in the schema as it now stands. It was
  // written when the tuple guard compared the snapshot against `agents`, a
  // column a later rebuild removed; the effective tuple guard compares against
  // the same legal-profile projection, so it reaches the same conclusion first.
  // It is defence in depth, and that is recorded here rather than asserted by a
  // case contorted into reaching it.
  it("refuses a contractor type the legal profile revision does not project", () => {
    // The snapshot is what the act and the payment are made out to. A
    // contractor type the verified legal profile does not project is a
    // document made out to someone who does not exist in that form.
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const target = unsettledEngagement(db, domain, partner);
    const template = settlementTemplate(rowOf(db, "SELECT * FROM reward_settlements WHERE id = ?", settlement.id), target);
    const projected = query<{ projected_contractor_type: string }>(db,
      "SELECT projected_contractor_type FROM agent_referrals_legal_profile_revisions WHERE id = ?", String(template.legal_profile_revision_id_snapshot));
    const other = projected.projected_contractor_type === "SELF_EMPLOYED" ? "INDIVIDUAL" : "SELF_EMPLOYED";

    expect(insertVariant(db, "reward_settlements", template, { contractor_type_snapshot: other }))
      .toThrow(/CONTRACTOR_TYPE_PROJECTION_MISMATCH|REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
  });
});

describe("a settlement's status moves only where it is allowed to", () => {
  it("refuses a transition that is not on the permitted path", () => {
    const { db, domain } = setup();
    const { settlement } = settled(db, domain);
    expect(query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", settlement.id).status).toBe("PREPARED");

    expect(() => db.prepare("UPDATE reward_settlements SET status = 'SETTLED' WHERE id = ?").run(settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TRANSITION_ILLEGAL/);
    expect(() => db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'made up' WHERE id = ?").run(settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TRANSITION_ILLEGAL/);
  });

  it("freezes a settlement that has reached a terminal status", () => {
    // Terminal means paid or abandoned. Either way the money question is
    // closed, and reopening the row is how it gets asked twice. The terminal
    // state is reached the way production reaches it - a reward correction
    // supersedes an unpaid settlement - rather than by an UPDATE the
    // transition guard would refuse anyway.
    const { db, domain } = setup();
    const { settlement, engagementId, order } = settled(db, domain);
    // A late refund is what actually moves the reward, so the correction has
    // something to correct.
    db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status,
      idempotency_key_hash, canonical_request_hash, succeeded_at)
      VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))`)
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund", String(settlement.effective_reward_snapshot_id));
    const superseded = query<{ status: string }>(db, "SELECT status FROM reward_settlements WHERE id = ?", settlement.id);
    expect(superseded.status).toBe("CANCELLED_BEFORE_PAYMENT");

    expect(() => db.prepare("UPDATE reward_settlements SET cancellation_reason = 'reopened' WHERE id = ?").run(settlement.id))
      .toThrow(/REWARD_SETTLEMENT_TERMINAL_IMMUTABLE/);
  });
});

describe("a settlement act is a document, not a record that can be tidied", () => {
  it("cannot be deleted", () => {
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const act = acceptedAct(db, partner.partner, settlement);
    expect(() => db.prepare("DELETE FROM settlement_acts WHERE id = ?").run(act.id))
      .toThrow(/SETTLEMENT_ACT_IMMUTABLE/);
  });

  it.each([
    "settlement_id = 'elsewhere'",
    "engagement_id = 'elsewhere'",
    "engagement_revision_id = 'elsewhere'",
    "effective_reward_snapshot_id = 'elsewhere'",
    "partner_identity_id = 'elsewhere'",
    "amount_kopecks = 1",
  ])("refuses to change %s", (assignment) => {
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    void partner;
    const { act } = generateSettlementAct(db, admin, settlement.id);

    expect(() => db.prepare(`UPDATE settlement_acts SET ${assignment} WHERE id = ?`).run(act.id))
      .toThrow(/SETTLEMENT_ACT_FIELDS_IMMUTABLE/);
  });

  it("cannot be changed at all once it has been presented", () => {
    // Presentation is the moment the partner was shown the document. After it,
    // every field is part of what they were shown.
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const act = acceptedAct(db, partner.partner, settlement);
    expect(query<{ presented_at: string | null }>(db, "SELECT presented_at FROM settlement_acts WHERE id = ?", act.id).presented_at).toBeTruthy();

    expect(() => db.prepare("UPDATE settlement_acts SET created_by_admin_id = 'after the fact' WHERE id = ?").run(act.id))
      .toThrow(/SETTLEMENT_ACT_ALREADY_PRESENTED/);
  });

  it.each([
    ["a settlement it does not belong to", "settlement_id"],
    ["an engagement its settlement does not name", "engagement_id"],
    ["a revision its settlement does not name", "engagement_revision_id"],
    ["a snapshot its settlement does not name", "effective_reward_snapshot_id"],
    ["a partner identity its settlement does not name", "partner_identity_id"],
    ["an amount its settlement does not carry", "amount_kopecks"],
  ] as const)("refuses an act naming %s", (_label, column) => {
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const act = acceptedAct(db, partner.partner, settlement);
    // A second settlement with no act of its own, so the act's unique key is
    // free and the relational guard is what decides. A different partner, so
    // its identity really is a different value.
    const second = settled(db, domain);
    const template = { ...rowOf(db, "SELECT * FROM settlement_acts WHERE id = ?", act.id), presented_at: null };
    const forSecond = {
      ...template, settlement_id: second.settlement.id, engagement_id: second.settlement.engagement_id,
      engagement_revision_id: second.settlement.engagement_revision_id,
      effective_reward_snapshot_id: second.settlement.effective_reward_snapshot_id,
      partner_identity_id: second.settlement.partner_identity_id, amount_kopecks: second.settlement.amount_kopecks,
    };
    expect(insertVariant(db, "settlement_acts", forSecond, {})).not.toThrow();

    const third = settled(db, domain, partner);
    const forThird = {
      ...template, settlement_id: third.settlement.id, engagement_id: third.settlement.engagement_id,
      engagement_revision_id: third.settlement.engagement_revision_id,
      effective_reward_snapshot_id: third.settlement.effective_reward_snapshot_id,
      partner_identity_id: third.settlement.partner_identity_id, amount_kopecks: third.settlement.amount_kopecks,
    };
    // The wrong value is a real one belonging to another settlement, so the
    // foreign key is satisfied and only the relational predicate can refuse it.
    // With a random id the case would pass whether the guard existed or not.
    const wrong = column === "amount_kopecks" ? Number(forThird.amount_kopecks) + 1 : forSecond[column];
    expect(wrong).not.toEqual(forThird[column]);
    expect(insertVariant(db, "settlement_acts", forThird, { [column]: wrong }))
      .toThrow(/SETTLEMENT_ACT_RELATIONAL_INCONSISTENT/);
  });

  it("freezes an acceptance once it is recorded", () => {
    // The acceptance is the partner's signature. Editing it rewrites what they
    // agreed to.
    const { db, domain } = setup();
    const { partner, settlement } = settled(db, domain);
    const act = acceptedAct(db, partner.partner, settlement);
    const acceptance = rowOf(db, "SELECT * FROM settlement_act_acceptances WHERE act_id = ?", act.id);
    expect(acceptance).toBeTruthy();

    expect(() => db.prepare("UPDATE settlement_act_acceptances SET accepted_amount_kopecks = 1 WHERE id = ?").run(acceptance.id))
      .toThrow(/SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE/);
    // Erasing a signature is not a lesser act than editing one.
    expect(() => db.prepare("DELETE FROM settlement_act_acceptances WHERE id = ?").run(acceptance.id))
      .toThrow(/SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE/);
  });
});
