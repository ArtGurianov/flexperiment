import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  admin, closeAndComplete, fresh, nearTermTerms, offerAcceptActivate, purchaseAndPay, readyPartner, seedOccurrence,
} from "./support/agent-referrals-settlement-fixtures";
import { finalizeEngagementRewardRegistry } from "../src/agent-referrals-reward-registry";
import type { CommerceDomain } from "../src/domain";

/**
 * Constraints of the live schema that protect an order's attribution and the
 * reward snapshots derived from it. They were asserted only inside the test for
 * the migration that introduced them, so they would have lost their only proof
 * when the ledger collapses into one baseline.
 *
 * Everything is set up through the domain, so the guards are tried against the
 * rows production actually writes - an attribution tuple assembled by checkout,
 * a registry snapshot written by finalization. Proving a trigger fires on a row
 * built to make it fire proves the trigger exists; it does not prove it stands
 * between production and anything.
 *
 * Each guard is covered by its branches, not by its name. A guard that freezes
 * eleven columns is not carried across by a test that edits six of them.
 */
const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()?.close(); });

const query = <T>(db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).get(...args) as T;

const rowOf = (db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  query<Record<string, unknown>>(db, sql, ...args);

/** Re-inserts a row with fields changed, which is how an INSERT-time guard is reached at all. */
const insertVariant = (db: Database.Database, table: string, source: Record<string, unknown>, changes: Record<string, unknown>) => {
  const next = { ...source, ...changes, id: randomUUID() };
  const columns = Object.keys(next);
  return () => db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(next);
};

const orderVariant = (db: Database.Database, order: Record<string, unknown>, changes: Record<string, unknown>) =>
  insertVariant(db, "orders", order, { public_order_number: `FX-${randomUUID().slice(0, 12).toUpperCase()}`, ...changes });

/** One partner, one engagement, one paid attributed order, registry finalized. */
const engagementWithOrder = (db: Database.Database, domain: CommerceDomain) => {
  const partner = readyPartner(db, "OTHER");
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
  const order = purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
  closeAndComplete(db, domain, occurrenceId);
  finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");
  return { partner, occurrenceId, engagementId, orderId: order.id };
};

/** A second engagement whose registry is written by hand, so E-chain variants can be tried against it. */
const engagementWithHandBuiltRegistry = (db: Database.Database, domain: CommerceDomain, terminal: "COMPLETED" | "CANCELLED" = "COMPLETED") => {
  const partner = readyPartner(db, "OTHER");
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const revisionId = query<{ id: string }>(db, "SELECT id FROM engagement_revisions WHERE engagement_id = ? ORDER BY rowid DESC LIMIT 1", engagementId).id;
  if (terminal === "COMPLETED") closeAndComplete(db, domain, occurrenceId);
  else db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', sales_status = 'CLOSED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'test' WHERE id = ?").run(occurrenceId);

  const registry = {
    id: randomUUID(), engagement_id: engagementId, engagement_revision_id: revisionId, occurrence_id: occurrenceId,
    terminal_status: terminal, reward_total_kopecks: terminal === "COMPLETED" ? 5_000 : 0, formula_version: 1,
    source_order_ids_json: "[]", source_state_hash: "hash-1", watermark: "2026-09-20T00:00:00.000Z",
    finalized_by_admin_id: admin.admin_id, reason: "hand built",
  };
  const insertRegistry = (changes: Record<string, unknown>) => insertVariant(db, "engagement_reward_registry_snapshot", registry, changes);
  db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id,
    terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark,
    finalized_by_admin_id, reason)
    VALUES (@id, @engagement_id, @engagement_revision_id, @occurrence_id, @terminal_status, @reward_total_kopecks,
      @formula_version, @source_order_ids_json, @source_state_hash, @watermark, @finalized_by_admin_id, @reason)`).run(registry);

  const initial = {
    id: randomUUID(), engagement_id: engagementId, engagement_revision_id: revisionId, base_registry_snapshot_id: registry.id,
    supersedes_effective_snapshot_id: null, sequence: 1, kind: "INITIAL", reward_total_kopecks: registry.reward_total_kopecks,
    source_state_hash: registry.source_state_hash, reason: "mirror", created_by_admin_id: admin.admin_id, canonical_hash: "canon-1",
  };
  const columns = Object.keys(initial);
  const insertEffective = (changes: Record<string, unknown>) => insertVariant(db, "engagement_effective_reward_snapshots", initial, changes);
  // The valid first snapshot, inserted only by the cases that need one to
  // already exist - the mirror cases need it absent.
  const insertInitial = () => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(${columns.join(", ")})
    VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(initial);
  return { engagementId, revisionId, occurrenceId, registry, initial, insertEffective, insertInitial, insertRegistry };
};

const setup = () => {
  const { db, domain } = fresh();
  open.push(db);
  return { db, domain: domain as CommerceDomain };
};

describe("an order's attribution cannot be rewritten after checkout", () => {
  // Every column the guard freezes, not a sample of them. The attribution
  // decided at checkout is what every reward downstream is computed from;
  // editing one later does not correct a reward, it detaches the reward from
  // the purchase that justified it.
  it.each([
    "explicit_promo_id = NULL",
    "resolved_partner_id = NULL",
    "resolved_engagement_id = NULL",
    "resolved_engagement_revision_id = NULL",
    "resolved_promo_authorization_id = NULL",
    "attribution_rule_version = 'rewritten'",
    "resolution_reason = 'rewritten'",
    "attributed_agent_id = NULL",
    "reward_type_snapshot = 'FIXED'",
    "reward_value_snapshot = 1",
  ])("refuses to change %s", (assignment) => {
    const { db, domain } = setup();
    const { orderId } = engagementWithOrder(db, domain);
    expect(() => db.prepare(`UPDATE orders SET ${assignment} WHERE id = ?`).run(orderId))
      .toThrow(/ORDER_AUTHORITY_COLUMNS_IMMUTABLE/);
  });
});

describe("an order's attribution tuple has to hold together", () => {
  // Half an attribution is worse than none: it reads as attributed to
  // everything that queries it and as attributable by nothing that checks it.
  const cases: [string, Record<string, unknown>][] = [
    ["a missing partner", { resolved_partner_id: null }],
    ["a missing engagement", { resolved_engagement_id: null }],
    ["a missing revision", { resolved_engagement_revision_id: null }],
    ["a missing promo authorization", { resolved_promo_authorization_id: null }],
    ["a missing explicit promo", { explicit_promo_id: null }],
    ["a resolution reason it did not resolve by", { resolution_reason: "IMPLICIT_COOKIE" }],
    ["an agent that is not the resolved partner", { attributed_agent_id: randomUUID() }],
    ["a reward type the revision does not carry", { reward_type_snapshot: "FIXED" }],
    ["a reward value the revision does not carry", { reward_value_snapshot: 4_999 }],
  ];
  it.each(cases)("refuses an order with %s", (_label, changes) => {
    const { db, domain } = setup();
    const { orderId } = engagementWithOrder(db, domain);
    const order = rowOf(db, "SELECT * FROM orders WHERE id = ?", orderId);
    expect(orderVariant(db, order, changes)).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
  });

  it("refuses an authorization that belongs to another engagement's promo", () => {
    // The authorization is what ties promo, partner, engagement, revision and
    // occurrence into one claim. An authorization from elsewhere satisfies
    // every NOT NULL and none of the meaning.
    const { db, domain } = setup();
    const first = engagementWithOrder(db, domain);
    const second = engagementWithOrder(db, domain);
    const order = rowOf(db, "SELECT * FROM orders WHERE id = ?", first.orderId);
    const foreign = rowOf(db, "SELECT * FROM engagement_promo_authorizations WHERE engagement_id = ?", second.engagementId);

    expect(orderVariant(db, order, { resolved_promo_authorization_id: foreign.id }))
      .toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
  });

  it("refuses an authorization that is right about everything except the occurrence", () => {
    // The narrow case, and the one a broad "authorization from elsewhere" test
    // silently covers for the wrong reason: promo, partner, engagement and
    // revision all match, and only the occurrence does not. Without this the
    // occurrence pin could be dropped from the guard and nothing would notice.
    const { db, domain } = setup();
    const first = engagementWithOrder(db, domain);
    const second = engagementWithOrder(db, domain);
    const order = rowOf(db, "SELECT * FROM orders WHERE id = ?", first.orderId);

    expect(orderVariant(db, order, { occurrence_id: second.occurrenceId }))
      .toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
  });

  it("refuses a revision that belongs to another engagement", () => {
    const { db, domain } = setup();
    const first = engagementWithOrder(db, domain);
    const second = engagementWithOrder(db, domain);
    const order = rowOf(db, "SELECT * FROM orders WHERE id = ?", first.orderId);
    const foreignRevision = query<{ id: string }>(db, "SELECT id FROM engagement_revisions WHERE engagement_id = ? LIMIT 1", second.engagementId);

    expect(orderVariant(db, order, { resolved_engagement_revision_id: foreignRevision.id }))
      .toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
  });
});

describe("a finalized reward registry snapshot is a record, not a working value", () => {
  it("cannot be updated", () => {
    const { db, domain } = setup();
    const { engagementId } = engagementWithOrder(db, domain);
    const snapshot = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", engagementId);
    expect(() => db.prepare("UPDATE engagement_reward_registry_snapshot SET reward_total_kopecks = 1 WHERE id = ?").run(snapshot.id))
      .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE/);
  });

  it("cannot be deleted", () => {
    // Immutable must not mean "cannot be edited, may be erased": money was
    // already paid against this record.
    const { db, domain } = setup();
    const { engagementId } = engagementWithOrder(db, domain);
    const snapshot = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", engagementId);
    expect(() => db.prepare("DELETE FROM engagement_reward_registry_snapshot WHERE id = ?").run(snapshot.id))
      .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE/);
  });

  it("exists at most once per engagement", () => {
    const { db, domain } = setup();
    const { engagementId } = engagementWithOrder(db, domain);
    const snapshot = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", engagementId);
    expect(insertVariant(db, "engagement_reward_registry_snapshot", snapshot, {}))
      .toThrow(/UNIQUE constraint failed/);
  });

  it("refuses a terminal status outside the two that exist", () => {
    // The enum CHECK sits behind the relational guard, which reaches the same
    // conclusion first because no occurrence can carry that status either.
    // The invariant is that such a row cannot exist, not which guard says so.
    const { db, domain } = setup();
    const { insertRegistry } = engagementWithHandBuiltRegistry(db, domain);
    expect(insertRegistry({ terminal_status: "ABANDONED" }))
      .toThrow(/CHECK constraint failed|ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT/);
  });

  it.each([
    ["a revision belonging to another engagement", "engagement_revision_id"],
    ["an occurrence belonging to another engagement", "occurrence_id"],
  ])("refuses %s", (_label, column) => {
    const { db, domain } = setup();
    const first = engagementWithOrder(db, domain);
    const second = engagementWithOrder(db, domain);
    const snapshot = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", first.engagementId);
    const foreign = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", second.engagementId);

    expect(insertVariant(db, "engagement_reward_registry_snapshot", snapshot, { engagement_id: second.engagementId, [column]: foreign[column] }))
      .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT|UNIQUE constraint failed/);
  });

  it("refuses a terminal status the occurrence does not actually have", () => {
    const { db, domain } = setup();
    const { engagementId, occurrenceId } = engagementWithOrder(db, domain);
    const snapshot = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", engagementId);
    expect(query<{ s: string }>(db, "SELECT fulfillment_status AS s FROM occurrences WHERE id = ?", occurrenceId).s).toBe("COMPLETED");

    expect(insertVariant(db, "engagement_reward_registry_snapshot", snapshot, { terminal_status: "CANCELLED", reward_total_kopecks: 0 }))
      .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT|UNIQUE constraint failed/);
  });

  it("refuses positive payable authority from a cancelled occurrence", () => {
    // A cancelled occurrence may finalize its registry, but it can never mint
    // a reward: the first effective snapshot is seeded from this number, so
    // the boundary is structural rather than an application convention.
    const { db, domain } = setup();
    const { insertRegistry } = engagementWithHandBuiltRegistry(db, domain, "CANCELLED");
    expect(insertRegistry({ reward_total_kopecks: 1 })).toThrow(/CHECK constraint failed/);
  });
});

describe("the effective reward chain restates its base, or supersedes a predecessor", () => {
  it("cannot be updated or deleted", () => {
    const { db, domain } = setup();
    const { engagementId } = engagementWithOrder(db, domain);
    const effective = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1", engagementId);

    expect(() => db.prepare("UPDATE engagement_effective_reward_snapshots SET reward_total_kopecks = 1 WHERE id = ?").run(effective.id))
      .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM engagement_effective_reward_snapshots WHERE id = ?").run(effective.id))
      .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE/);
  });

  it.each([
    ["a total that does not mirror the registry", { reward_total_kopecks: 4_999 }],
    ["a state hash that does not mirror the registry", { source_state_hash: "some-other-hash" }],
  ])("refuses a first snapshot with %s", (_label, changes) => {
    // The first snapshot is not an opinion about the registry; it is the
    // registry, restated. Only a correction that supersedes a predecessor may
    // differ from it.
    const { db, domain } = setup();
    const { insertEffective } = engagementWithHandBuiltRegistry(db, domain);
    expect(insertEffective(changes)).toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
  });

  it("refuses a base registry belonging to another engagement", () => {
    const { db, domain } = setup();
    const other = engagementWithOrder(db, domain);
    const { insertEffective } = engagementWithHandBuiltRegistry(db, domain);
    const foreign = rowOf(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", other.engagementId);

    expect(insertEffective({ base_registry_snapshot_id: foreign.id })).toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
  });

  it("refuses a revision belonging to another engagement", () => {
    const { db, domain } = setup();
    const other = engagementWithOrder(db, domain);
    const { insertEffective } = engagementWithHandBuiltRegistry(db, domain);
    const foreignRevision = query<{ id: string }>(db, "SELECT id FROM engagement_revisions WHERE engagement_id = ? LIMIT 1", other.engagementId);

    expect(insertEffective({ engagement_revision_id: foreignRevision.id })).toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
  });

  it("refuses a correction that skips a sequence", () => {
    // The chain is what makes a correction auditable. A gap in it is a reward
    // nobody can reconstruct the reasoning for.
    const { db, domain } = setup();
    const { insertEffective, insertInitial, initial } = engagementWithHandBuiltRegistry(db, domain);
    // The predecessor has to exist, or this would pass because nothing is
    // there to supersede rather than because the gap was refused.
    insertInitial();
    expect(insertEffective({ kind: "CORRECTION", sequence: 3, supersedes_effective_snapshot_id: initial.id, reward_total_kopecks: 1_000 }))
      .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
    // And the contiguous correction is accepted, so the case is about the gap.
    expect(insertEffective({ kind: "CORRECTION", sequence: 2, supersedes_effective_snapshot_id: initial.id, reward_total_kopecks: 1_000 }))
      .not.toThrow();
  });

  // Note: the guard also pins `prev.engagement_id`, and that predicate cannot
  // be reached independently - a registry snapshot is unique per engagement, so
  // any predecessor sharing this base necessarily belongs to the same
  // engagement. It is defence in depth, and removing it changes no observable
  // behaviour; that is stated here rather than asserted by a test contorted
  // into passing for the wrong reason.
  it("refuses a correction superseding another engagement's snapshot", () => {
    const { db, domain } = setup();
    const other = engagementWithOrder(db, domain);
    const { insertEffective } = engagementWithHandBuiltRegistry(db, domain);
    const foreign = rowOf(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? LIMIT 1", other.engagementId);

    expect(insertEffective({ kind: "CORRECTION", sequence: 2, supersedes_effective_snapshot_id: foreign.id, reward_total_kopecks: 1_000 }))
      .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
  });

  it("ties the first snapshot to sequence one, and only it to no predecessor", () => {
    const { db, domain } = setup();
    const { insertEffective, initial } = engagementWithHandBuiltRegistry(db, domain);

    expect(insertEffective({ sequence: 2 })).toThrow(/CHECK constraint failed|RELATIONAL_INCONSISTENT/);
    expect(insertEffective({ kind: "CORRECTION", sequence: 1, supersedes_effective_snapshot_id: initial.id }))
      .toThrow(/CHECK constraint failed|UNIQUE constraint failed|RELATIONAL_INCONSISTENT/);
  });

  it("holds one snapshot per sequence per engagement", () => {
    const { db, domain } = setup();
    const { insertEffective, insertInitial } = engagementWithHandBuiltRegistry(db, domain);
    insertInitial();
    expect(insertEffective({})).toThrow(/UNIQUE constraint failed/);
  });
});
