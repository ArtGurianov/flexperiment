import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  admin, closeAndComplete, fresh, nearTermTerms, offerAcceptActivate, purchaseAndPay, readyPartner, seedOccurrence,
} from "./support/agent-referrals-settlement-fixtures";
import { finalizeEngagementRewardRegistry } from "../src/agent-referrals-reward-registry";

/**
 * Constraints of the live schema that protect an order's attribution and the
 * reward snapshots derived from it. They were asserted only inside the test for
 * the migration that introduced them, which meant they would have lost their
 * only proof when the ledger collapses into one baseline.
 *
 * Everything here is set up through the domain rather than by hand, so the rows
 * the guards are tried against are the rows production actually writes - an
 * attribution tuple assembled by checkout, a registry snapshot written by
 * finalization. A guard proved against a row invented by the test proves that
 * the trigger fires, not that it fires on anything real.
 */
const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()?.close(); });

const attributed = () => {
  const { db, domain } = fresh();
  open.push(db);
  const partner = readyPartner(db, "OTHER");
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(partner.promo.promo_code_id) as { code: string };
  const order = purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);

  closeAndComplete(db, domain, occurrenceId);
  finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");
  return { db, domain, occurrenceId, engagementId, orderId: order.id };
};

const row = (db: Database.Database, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...(args as [])) as Record<string, unknown>;

/** Re-inserts a row with one field changed, which is how a relational guard is reached at all. */
const reinsert = (db: Database.Database, table: string, source: Record<string, unknown>, changes: Record<string, unknown>) => {
  const next = { ...source, ...changes, id: randomUUID() };
  const columns = Object.keys(next);
  return () => db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(next);
};

describe("order attribution cannot be rewritten after the fact", () => {
  it("freezes every attribution column of an order", () => {
    // The attribution decided at checkout is what every reward downstream is
    // computed from. Editing it later does not correct a reward; it detaches
    // the reward from the purchase that justified it.
    const { db, orderId } = attributed();
    for (const assignment of [
      "resolved_partner_id = NULL",
      "resolved_engagement_id = NULL",
      "resolved_engagement_revision_id = NULL",
      "explicit_promo_id = NULL",
      "attribution_rule_version = 'rewritten'",
      "resolution_reason = 'rewritten'",
    ]) {
      expect(() => db.prepare(`UPDATE orders SET ${assignment} WHERE id = ?`).run(orderId))
        .toThrow(/ORDER_AUTHORITY_COLUMNS_IMMUTABLE/);
    }
  });

  it("refuses an order whose attribution tuple does not hold together", () => {
    // Half an attribution is worse than none: a partner with no engagement, or
    // an engagement with no authorization, reads as attributed to everything
    // that queries it and as attributable by nothing that checks it.
    const { db, orderId } = attributed();
    const order = row(db, "SELECT * FROM orders WHERE id = ?", orderId);
    expect(order.reward_authority_kind).toBe("ENGAGEMENT_SCOPED");

    expect(reinsert(db, "orders", order, { public_order_number: `FX-${randomUUID().slice(0, 12).toUpperCase()}`, resolved_engagement_id: null }))
      .toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
    expect(reinsert(db, "orders", order, { public_order_number: `FX-${randomUUID().slice(0, 12).toUpperCase()}`, resolved_partner_id: null }))
      .toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
  });
});

describe("reward snapshots are immutable and internally consistent", () => {
  it("freezes a reward registry snapshot once finalization has written it", () => {
    // It is the record of what the engagement earned at the moment the
    // occurrence terminated. A later edit rewrites history that money was
    // already paid against.
    const { db, engagementId } = attributed();
    const snapshot = row(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", engagementId);
    expect(snapshot).toBeTruthy();

    expect(() => db.prepare("UPDATE engagement_reward_registry_snapshot SET reward_total_kopecks = 1 WHERE id = ?").run(snapshot.id))
      .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE/);
  });

  it("refuses a registry snapshot that does not agree with the engagement it claims", () => {
    const { db, engagementId, occurrenceId } = attributed();
    const snapshot = row(db, "SELECT * FROM engagement_reward_registry_snapshot WHERE engagement_id = ?", engagementId);

    // A revision belonging to another engagement.
    expect(reinsert(db, "engagement_reward_registry_snapshot", snapshot, { engagement_revision_id: randomUUID() }))
      .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT/);
    // A terminal status the occurrence does not actually have.
    expect(row(db, "SELECT fulfillment_status AS s FROM occurrences WHERE id = ?", occurrenceId).s).toBe("COMPLETED");
    expect(reinsert(db, "engagement_reward_registry_snapshot", snapshot, { terminal_status: "CANCELLED" }))
      .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT/);
  });

  it("freezes an effective reward snapshot", () => {
    const { db, engagementId } = attributed();
    const effective = row(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1", engagementId);
    expect(effective).toBeTruthy();

    expect(() => db.prepare("UPDATE engagement_effective_reward_snapshots SET reward_total_kopecks = 1 WHERE id = ?").run(effective.id))
      .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE/);
  });

  it("refuses an effective snapshot that does not match the registry it is based on", () => {
    // The first snapshot of a chain must restate its base exactly; only a
    // correction that supersedes a predecessor may differ from it.
    const { db, engagementId } = attributed();
    const effective = row(db, "SELECT * FROM engagement_effective_reward_snapshots WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1", engagementId);

    expect(reinsert(db, "engagement_effective_reward_snapshots", effective, { sequence: 9, reward_total_kopecks: Number(effective.reward_total_kopecks) + 1 }))
      .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
    expect(reinsert(db, "engagement_effective_reward_snapshots", effective, { sequence: 9, base_registry_snapshot_id: randomUUID() }))
      .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
  });
});
