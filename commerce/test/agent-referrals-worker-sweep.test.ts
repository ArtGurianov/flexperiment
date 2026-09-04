import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentReferralsWorkerSweep, REMOVAL_OVERDUE_GRACE_MS } from "../src/agent-referrals-worker-sweep";
import { reportDistribution, distributionProjection, claimRemoval, confirmRemoval } from "../src/agent-referrals-distribution";
import { beginPayment } from "../src/agent-referrals-payment";
import {
  fresh, admin, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, finalizedSettlement, acceptedAct,
} from "./support/agent-referrals-settlement-fixtures";

process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_ID ??= "test-payout-key-for-agent-referrals-worker-sweep-test";
process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_BASE64 ??= Buffer.alloc(32, 3).toString("base64");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const track = (db: Database.Database) => { open.push(db); return db; };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Activates an engagement with a near-term window and then waits it out.
 * engagement_revisions is immutable by construction (no UPDATE path exists
 * at all - see 0045's own guard), and activateEngagement itself refuses an
 * already-past window, so the only way to reach "activated, now ended" is
 * to genuinely let a short, real window elapse.
 */
const activatedWithEndedWindow = async (db: Database.Database) => {
  const p1 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p1.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
  await wait(400);
  return { p1, engagementId };
};

describe("Agent Referrals worker sweep (Phase 9 §11): deterministic, idempotent, no VK network call of any kind", () => {
  it("is a silent all-zero no-op while the feature is DORMANT - never throws AGENT_REFERRALS_FEATURE_DORMANT", () => {
    const { db } = fresh();
    track(db);
    expect(() => runAgentReferralsWorkerSweep(db)).not.toThrow();
    expect(runAgentReferralsWorkerSweep(db)).toEqual({ removal_required_marked: 0, removal_overdue_marked: 0, payment_attempts_recovered: 0 });
  });

  it("marks REMOVAL_REQUIRED for a distribution whose engagement's active revision publication window has already ended, and never re-marks an already-classified one", async () => {
    const { db } = fresh();
    track(db);
    const { engagementId } = await activatedWithEndedWindow(db);
    reportDistribution(db, admin, engagementId, {
      channel_key: "telegram", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1",
      published_at: "2020-01-01T00:00:00.000Z", ended_at: null, evidence_ref: "ev-1",
    });
    const distributionId = (db.prepare("SELECT id FROM engagement_distributions WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    expect(distributionProjection(db, distributionId).removal_state).toBeNull();

    const first = runAgentReferralsWorkerSweep(db);
    expect(first.removal_required_marked).toBe(1);
    expect(distributionProjection(db, distributionId).removal_state).toBe("REMOVAL_REQUIRED");

    const second = runAgentReferralsWorkerSweep(db);
    expect(second.removal_required_marked).toBe(0);
  });

  it("escalates a distribution stuck REMOVAL_REQUIRED past the grace window to OVERDUE_REMOVAL, but never one still within it", async () => {
    const { db } = fresh();
    track(db);
    const { engagementId } = await activatedWithEndedWindow(db);
    reportDistribution(db, admin, engagementId, {
      channel_key: "telegram", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1",
      published_at: "2020-01-01T00:00:00.000Z", ended_at: null, evidence_ref: "ev-1",
    });
    const distributionId = (db.prepare("SELECT id FROM engagement_distributions WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    // Directly mint REMOVAL_REQUIRED with an explicit occurred_at in the past,
    // rather than through the sweep - controls the exact "how long ago" fact
    // independent of when this test happens to run.
    const backdated = new Date(Date.now() - REMOVAL_OVERDUE_GRACE_MS - 60_000).toISOString();
    db.prepare(`INSERT INTO engagement_distribution_events(id, distribution_id, event_sequence, event_kind, actor_realm, evidence_ref, reason, occurred_at)
      VALUES (?, ?, (SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM engagement_distribution_events WHERE distribution_id = ?), 'REMOVAL_REQUIRED', 'ADMIN', NULL, 'backdated for test', ?)`)
      .run(randomUUID(), distributionId, distributionId, backdated);
    expect(distributionProjection(db, distributionId).removal_state).toBe("REMOVAL_REQUIRED");

    const swept = runAgentReferralsWorkerSweep(db);
    expect(swept.removal_overdue_marked).toBe(1);
    expect(distributionProjection(db, distributionId).removal_state).toBe("OVERDUE_REMOVAL");
  });

  it("never re-escalates a distribution the partner already claimed and the admin already confirmed removed", async () => {
    const { db } = fresh();
    track(db);
    const { p1, engagementId } = await activatedWithEndedWindow(db);
    reportDistribution(db, admin, engagementId, {
      channel_key: "telegram", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1",
      published_at: "2020-01-01T00:00:00.000Z", ended_at: null, evidence_ref: "ev-1",
    });
    const distributionId = (db.prepare("SELECT id FROM engagement_distributions WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    const backdated = new Date(Date.now() - REMOVAL_OVERDUE_GRACE_MS - 60_000).toISOString();
    db.prepare(`INSERT INTO engagement_distribution_events(id, distribution_id, event_sequence, event_kind, actor_realm, evidence_ref, reason, occurred_at)
      VALUES (?, ?, (SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM engagement_distribution_events WHERE distribution_id = ?), 'REMOVAL_REQUIRED', 'ADMIN', NULL, 'backdated for test', ?)`)
      .run(randomUUID(), distributionId, distributionId, backdated);
    claimRemoval(db, p1.partner, distributionId, "evidence-of-takedown");
    confirmRemoval(db, admin, distributionId, "confirmed-evidence");
    expect(distributionProjection(db, distributionId).removal_state).toBe("REMOVAL_CONFIRMED");

    const swept = runAgentReferralsWorkerSweep(db);
    expect(swept.removal_overdue_marked).toBe(0);
    expect(distributionProjection(db, distributionId).removal_state).toBe("REMOVAL_CONFIRMED");
  });

  it("recovers a stuck IN_PROGRESS payment attempt to PAYOUT_UNKNOWN after the staleness window, and is idempotent on replay", () => {
    const { db, domain } = fresh();
    track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "customer@example.test", `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    acceptedAct(db, p1.partner, settlement);
    const { attempt } = beginPayment(db, admin, settlement.id);
    expect(attempt.status).toBe("IN_PROGRESS");
    // payment_attempts is immutable except through its own legal-transition
    // triggers, so started_at can never be backdated directly. Instead,
    // simulate the sweep running well after the staleness window by passing
    // a future `atMs` - runAgentReferralsWorkerSweep/recoverStuckPaymentAttempts
    // both take the "as of" instant as an explicit parameter, exactly the
    // same "never read the wall clock internally" discipline used
    // throughout this codebase's other time-dependent oracles.
    const future = Date.now() + 60 * 60_000;
    const swept = runAgentReferralsWorkerSweep(db, future);
    expect(swept.payment_attempts_recovered).toBe(1);
    expect((db.prepare("SELECT status FROM payment_attempts WHERE id = ?").get(attempt.id) as { status: string }).status).toBe("PAYOUT_UNKNOWN");

    const second = runAgentReferralsWorkerSweep(db, future);
    expect(second.payment_attempts_recovered).toBe(0);
  });
});
