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

/**
 * Activates an engagement with a near-term window (activateEngagement
 * itself refuses an already-past one, and engagement_revisions is immutable
 * - no UPDATE path exists to backdate publication_end_at directly). The
 * window's real wall-clock deadline is a few hundred ms out; every test
 * below decides "ended" or not entirely via the `atMs` it supplies to
 * runAgentReferralsWorkerSweep, never by waiting for real time to pass.
 */
const activatedWithNearTermWindow = (db: Database.Database) => {
  const p1 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p1.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
  const revision = db.prepare("SELECT publication_end_at FROM engagement_revisions WHERE engagement_id = ?").get(engagementId) as { publication_end_at: string };
  return { p1, engagementId, publicationEndAtMs: new Date(revision.publication_end_at).getTime() };
};

const reportSampleDistribution = (db: Database.Database, engagementId: string) => {
  reportDistribution(db, admin, engagementId, {
    channel_key: "telegram", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1",
    published_at: "2020-01-01T00:00:00.000Z", ended_at: null, evidence_ref: "ev-1",
  });
  return (db.prepare("SELECT id FROM engagement_distributions WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
};

describe("Agent Referrals worker sweep (Phase 9 §11): deterministic, idempotent, no VK network call of any kind", () => {
  it("is a silent all-zero no-op while the feature is DORMANT - never throws AGENT_REFERRALS_FEATURE_DORMANT", () => {
    const { db } = fresh();
    track(db);
    expect(() => runAgentReferralsWorkerSweep(db)).not.toThrow();
    expect(runAgentReferralsWorkerSweep(db)).toEqual({
      removal_required_marked: 0, removal_overdue_marked: 0, payment_attempts_recovered: 0,
      review_queue_counts: {
        distributions_review_required: 0, distributions_removal_overdue: 0, distributions_reporting_tail_incomplete: 0,
        acts_awaiting_presentation: 0, payment_attempts_payout_unknown: 0, npd_reconciliation_needed: 0,
        partners_profile_pending_verification: 0, partners_framework_not_issued: 0,
      },
    });
  });

  it("marks REMOVAL_REQUIRED once atMs is past the publication window, never before, and never re-marks an already-classified one", () => {
    const { db } = fresh();
    track(db);
    const { engagementId, publicationEndAtMs } = activatedWithNearTermWindow(db);
    const distributionId = reportSampleDistribution(db, engagementId);
    expect(distributionProjection(db, distributionId).removal_state).toBeNull();

    // Still within the window per the supplied atMs - must not mark, even
    // though the real wall clock may already be past it by the time this
    // assertion runs (the sweep must never consult Date.now() itself).
    const beforeDeadline = runAgentReferralsWorkerSweep(db, publicationEndAtMs - 1);
    expect(beforeDeadline.removal_required_marked).toBe(0);
    expect(distributionProjection(db, distributionId).removal_state).toBeNull();

    const afterDeadline = runAgentReferralsWorkerSweep(db, publicationEndAtMs + 1);
    expect(afterDeadline.removal_required_marked).toBe(1);
    expect(distributionProjection(db, distributionId).removal_state).toBe("REMOVAL_REQUIRED");

    const replay = runAgentReferralsWorkerSweep(db, publicationEndAtMs + 1);
    expect(replay.removal_required_marked).toBe(0);
  });

  it("is a pure function of (db, atMs): the same database and the same supplied atMs produce the same result regardless of how much real wall-clock time elapses between calls", async () => {
    const { db } = fresh();
    track(db);
    const { engagementId, publicationEndAtMs } = activatedWithNearTermWindow(db);
    reportSampleDistribution(db, engagementId);

    // A fixed instant already past the window, held constant while real
    // time actually moves forward around the two calls below - proves
    // sweepRemovalRequired reads only the supplied atMs, never Date.now().
    const fixedAtMs = publicationEndAtMs + 5_000;
    const first = runAgentReferralsWorkerSweep(db, fixedAtMs);
    expect(first.removal_required_marked).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Same fixed instant again: nothing left to mark (already marked above),
    // and no throw or drift from the real time that passed in between.
    const second = runAgentReferralsWorkerSweep(db, fixedAtMs);
    expect(second.removal_required_marked).toBe(0);
  });

  it("escalates a distribution stuck REMOVAL_REQUIRED past the grace window to OVERDUE_REMOVAL, but never one still within it", () => {
    const { db } = fresh();
    track(db);
    const { engagementId, publicationEndAtMs } = activatedWithNearTermWindow(db);
    const distributionId = reportSampleDistribution(db, engagementId);
    // Directly mint REMOVAL_REQUIRED with an explicit occurred_at in the
    // past, rather than through the sweep - controls the exact "how long
    // ago" fact independent of when this test happens to run.
    const backdated = new Date(Date.now() - REMOVAL_OVERDUE_GRACE_MS - 60_000).toISOString();
    db.prepare(`INSERT INTO engagement_distribution_events(id, distribution_id, event_sequence, event_kind, actor_realm, evidence_ref, reason, occurred_at)
      VALUES (?, ?, (SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM engagement_distribution_events WHERE distribution_id = ?), 'REMOVAL_REQUIRED', 'ADMIN', NULL, 'backdated for test', ?)`)
      .run(randomUUID(), distributionId, distributionId, backdated);
    expect(distributionProjection(db, distributionId).removal_state).toBe("REMOVAL_REQUIRED");

    const swept = runAgentReferralsWorkerSweep(db, publicationEndAtMs + 1);
    expect(swept.removal_overdue_marked).toBe(1);
    expect(distributionProjection(db, distributionId).removal_state).toBe("OVERDUE_REMOVAL");
  });

  it("never re-escalates a distribution the partner already claimed and the admin already confirmed removed", () => {
    const { db } = fresh();
    track(db);
    const { p1, engagementId, publicationEndAtMs } = activatedWithNearTermWindow(db);
    const distributionId = reportSampleDistribution(db, engagementId);
    const backdated = new Date(Date.now() - REMOVAL_OVERDUE_GRACE_MS - 60_000).toISOString();
    db.prepare(`INSERT INTO engagement_distribution_events(id, distribution_id, event_sequence, event_kind, actor_realm, evidence_ref, reason, occurred_at)
      VALUES (?, ?, (SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM engagement_distribution_events WHERE distribution_id = ?), 'REMOVAL_REQUIRED', 'ADMIN', NULL, 'backdated for test', ?)`)
      .run(randomUUID(), distributionId, distributionId, backdated);
    claimRemoval(db, p1.partner, distributionId, "evidence-of-takedown");
    confirmRemoval(db, admin, distributionId, "confirmed-evidence");
    expect(distributionProjection(db, distributionId).removal_state).toBe("REMOVAL_CONFIRMED");

    const swept = runAgentReferralsWorkerSweep(db, publicationEndAtMs + 1);
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
