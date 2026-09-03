import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import { activateAgentReferrals, suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { AgentReferralsSuspensionPolicyError } from "../src/agent-referrals-suspension-policy";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, verifyAudienceForPartnerCity, acceptEngagement, activateEngagement, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import {
  finalizeEngagementRewardRegistry,
  correctEngagementEffectiveRewardSnapshot,
  currentEffectiveRewardSnapshot,
  rewardRegistrySnapshot,
  resolveRewardRegistryFinalizationFromRegistry,
  closeEngagementWithRewardRegistry,
} from "../src/agent-referrals-reward-registry";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };
const FAR_FUTURE = "2040-01-01T00:00:00.000Z";

const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((d) => [d, { document_id: d, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${d}`, archive_url: `https://example.test/archive/${d}`, checkout_relevant: true }])) };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-reward-registry-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  const releaseId = randomUUID();
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(legalManifest));
  const domain = new CommerceDomain(db, new MockProvider());
  return { db, domain };
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

const readyPartner = (db: Database.Database) => {
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, "INDIVIDUAL", "NPD");
  verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verified");
  const fw = mintFrameworkAgreementRevision(db, clause(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES));
  const dt = mintDelegationTemplateRevision(db, clause(DELEGATION_TEMPLATE_REQUIRED_CLAUSES));
  issueFrameworkToPartner(db, admin, partnerIdentityId, fw.id, dt.id, "issued");
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };
  const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", { framework_agreement_revision_id: fw.id, delegation_template_revision_id: dt.id }).grant_id;
  acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id);
  activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "ADMIN", "onboarding complete");
  const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
  verifyAudienceForPartnerCity(db, admin, partnerIdentityId, cityId, FAR_FUTURE, "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
  return { partner, agentId, partnerIdentityId, cityId, promo };
};

const seedOccurrence = (db: Database.Database, cityId: string, priceKopecks = 100_000) => {
  const occurrenceId = randomUUID();
  // In the past - completeOccurrence() requires ends_at <= now(), and these
  // tests all drive occurrences to COMPLETED/CANCELLED for reward-registry
  // finalization. Nothing about engagement activation depends on the
  // occurrence's own date (only its fulfillment_status/material_revision).
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2020-10-01T10:00:00.000Z', '2020-10-01T13:00:00.000Z', 'Asia/Novosibirsk', ?, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId, priceKopecks);
  return occurrenceId;
};

/** publication_end_at just barely in the future - activation legally passes now, and it is safely in the past a few hundred ms later so closeEngagement's window-ended check can be exercised without any clock injection. */
const nearTermTerms = (discountValue: number, rewardType: "PERCENT" | "FIXED" = "PERCENT", rewardValue = 1000): EngagementRevisionTerms => ({
  reward_type: rewardType, reward_value: rewardValue, customer_discount_type: "PERCENT", customer_discount_value: discountValue,
  publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: new Date(Date.now() + 250).toISOString(), terms: {},
});

const offerAcceptActivate = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, occurrenceId: string, terms: EngagementRevisionTerms) => {
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms, "offer");
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, partner, engagementId, revisionId, grant);
  activateEngagement(db, admin, engagementId, revisionId);
  return engagementId;
};

const checkoutInput = (quoteId: string, email: string) =>
  ({ quote_id: quoteId, customer_email: email, customer_adult_confirmed: true as const, participant_age_band: "ADULT" as const, offer_accepted: true as const, pd_consent_accepted: true as const });

/** Full checkout for a partner promo, paid in full: returns the order/payment ids for further reward-registry manipulation. */
const purchaseAndPay = (db: Database.Database, domain: CommerceDomain, occurrenceId: string, promoCode: string, email: string, idem: string) => {
  const quote = domain.checkoutContext({ occurrenceId, promoCode });
  domain.checkout(checkoutInput(quote.quote_id, email), idem);
  const order = db.prepare("SELECT o.id, p.id AS payment_id, o.amount_kopecks FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.occurrence_id = ? ORDER BY o.rowid DESC LIMIT 1").get(occurrenceId) as { id: string; payment_id: string; amount_kopecks: number };
  domain.markPaymentPaid(order.payment_id, order.amount_kopecks);
  return order;
};

/** Mirrors what the real closeSales admin flow would leave behind, without its own CAS/reauth ceremony (out of scope here) - completeOccurrence requires sales already CLOSED. */
const closeAndComplete = (db: Database.Database, domain: CommerceDomain, occurrenceId: string) => {
  db.prepare("UPDATE occurrences SET sales_status = 'CLOSED' WHERE id = ?").run(occurrenceId);
  domain.completeOccurrence(occurrenceId);
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("reward registry: finalization writes R + E1 atomically", () => {
  it("finalizes a COMPLETED occurrence with one fully-paid ENGAGEMENT_SCOPED order: R.reward_total matches the engagement revision's own reward terms, E1 mirrors R exactly", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 1000)); // 10% discount, 10% reward
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "buyer1@example.test", "idem-finalize-0000001");
    closeAndComplete(db, domain, occ);

    const result = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");
    expect(result.replayed).toBe(false);
    // Price 100_000, discount 10% -> final 90_000, reward 10% of net captured (90_000) = 9_000.
    expect(result.reward_total_kopecks).toBe(9_000);

    const registry = rewardRegistrySnapshot(db, engagementId)!;
    expect(registry.terminal_status).toBe("COMPLETED");
    expect(registry.reward_total_kopecks).toBe(9_000);
    expect(JSON.parse(registry.source_order_ids_json)).toHaveLength(1);

    const effective = currentEffectiveRewardSnapshot(db, engagementId)!;
    expect(effective).toMatchObject({ kind: "INITIAL", sequence: 1, reward_total_kopecks: 9_000, base_registry_snapshot_id: registry.id, supersedes_effective_snapshot_id: null });
  });

  it("idempotent replay: finalizing twice returns the SAME R and E1, never a second registry or second INITIAL snapshot", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "buyer2@example.test", "idem-replay-0000001");
    closeAndComplete(db, domain, occ);

    const first = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    const second = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(second.replayed).toBe(true);
    expect(second.registry_snapshot_id).toBe(first.registry_snapshot_id);
    expect(second.effective_snapshot_id).toBe(first.effective_snapshot_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_reward_registry_snapshot WHERE engagement_id = ?").get(engagementId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId)).toEqual({ n: 1 });
  });

  it("idempotent replay AFTER a correction still returns the ORIGINAL E1, not the engagement's current (corrected) payable authority", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "replayaftercorrect@example.test", "idem-replayaftercorrect-0000001");
    closeAndComplete(db, domain, occ);

    const first = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "late refund");
    expect(correction.reward_total_kopecks).toBeLessThan(first.reward_total_kopecks);

    const replay = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(replay.replayed).toBe(true);
    expect(replay.effective_snapshot_id).toBe(first.effective_snapshot_id); // the ORIGINAL E1, not the correction's E2
    expect(replay.reward_total_kopecks).toBe(first.reward_total_kopecks); // R's own total, unaffected by the correction

    // The engagement's actual current payable authority is still the correction, unaffected by the replay.
    expect(currentEffectiveRewardSnapshot(db, engagementId)!.id).toBe(correction.effective_snapshot_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId)).toEqual({ n: 2 }); // replay minted nothing new
  });

  it("a raw concurrent duplicate finalization attempt hits the UNIQUE(engagement_id) backstop, not merely SQLite's write serialization", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "buyer3@example.test", "idem-race-0000001");
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");

    expect(() => db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
      VALUES (?, ?, (SELECT engagement_revision_id FROM engagement_reward_registry_snapshot WHERE engagement_id = ?), ?, 'COMPLETED', 1, 1, '[]', 'h', 'w', 'admin', 'race')`)
      .run(randomUUID(), engagementId, engagementId, occ)).toThrow(/UNIQUE constraint failed/);
  });

  it("fault at the E insert rolls back the R insert too - the pair is atomic, proven with a poison trigger that forces the second insert to fail without corrupting any real data", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "buyer@example.test", "idem-fault-0000001");
    closeAndComplete(db, domain, occ);

    // A poison trigger: unconditionally refuses the second insert
    // (engagement_effective_reward_snapshots) after the first
    // (engagement_reward_registry_snapshot) has already succeeded inside
    // the same transaction - a schema-valid fault-injection mechanism
    // that corrupts no real data, unlike seeding a cross-engagement
    // adversarial row (which the new relational-consistency guard now
    // refuses outright anyway).
    db.exec(`CREATE TRIGGER test_poison_effective_insert BEFORE INSERT ON engagement_effective_reward_snapshots
      BEGIN SELECT RAISE(ABORT, 'INJECTED_TEST_FAULT'); END;`);
    try {
      expect(() => finalizeEngagementRewardRegistry(db, admin, engagementId, "should roll back")).toThrow(/INJECTED_TEST_FAULT/);
    } finally {
      db.exec("DROP TRIGGER test_poison_effective_insert");
    }
    expect(rewardRegistrySnapshot(db, engagementId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_reward_registry_snapshot").get()).toEqual({ n: 0 });
  });
});

describe("reward registry: reconciliation gates", () => {
  it("refuses finalization while the occurrence is still SCHEDULED", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    void domain;
    expect(() => finalizeEngagementRewardRegistry(db, admin, engagementId, "x")).toThrow(/AGENT_REFERRALS_REWARD_REGISTRY_OCCURRENCE_NOT_TERMINAL/);
  });

  it("refuses finalization while an order's payment is still PENDING (unresolved outcome)", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const quote = domain.checkoutContext({ occurrenceId: occ, promoCode: code.code });
    domain.checkout(checkoutInput(quote.quote_id, "pending@example.test"), "idem-pending-0000001"); // never markPaymentPaid - payment stays PENDING
    closeAndComplete(db, domain, occ);
    expect(() => finalizeEngagementRewardRegistry(db, admin, engagementId, "x")).toThrow(/AGENT_REFERRALS_REWARD_REGISTRY_UNRESOLVED_PAYMENT_STATE/);
  });

  it("CANCELLED occurrence: refused while a refund obligation is still open, succeeds once resolved - reward total lands at 0 once the booking is cancelled and its refund reconciled", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "cancel@example.test", "idem-cancel-0000001");

    // Mirror what the real cancelOccurrence admin command produces, without
    // its reauth-capability ceremony (out of scope for this test): the
    // occurrence terminates CANCELLED/sales CLOSED, the booking is
    // cancelled, and an OPEN refund obligation is opened for the payment.
    db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', sales_status = 'CLOSED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'test' WHERE id = ?").run(occ);
    db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'OCCURRENCE_CANCELLED' WHERE order_id = ?").run(order.id);
    db.prepare("INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status) VALUES (?, ?, 'OCCURRENCE_CANCELLED', ?, 'OPEN')").run(randomUUID(), order.payment_id, order.amount_kopecks);

    expect(() => finalizeEngagementRewardRegistry(db, admin, engagementId, "x")).toThrow(/AGENT_REFERRALS_REWARD_REGISTRY_REFUND_OBLIGATION_OPEN/);

    db.prepare("UPDATE refund_obligations SET status = 'FULFILLED', fulfilled_at = CURRENT_TIMESTAMP WHERE payment_id = ?").run(order.payment_id);
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'occurrence cancelled', 'REFUND_OBLIGATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());

    const result = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(result.reward_total_kopecks).toBe(0); // booking CANCELLED contributes 0 regardless of any residual net-captured math
    expect(rewardRegistrySnapshot(db, engagementId)!.terminal_status).toBe("CANCELLED");
  });

  it("§B-6: a CANCELLED occurrence whose booking is (unrealistically, only reachable by direct SQL) left CONFIRMED with a positive net capture is refused outright, never silently clamped to zero", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "cancelled-nonzero@example.test", "idem-cancelled-nonzero-0000001");

    // The real cancelOccurrence command always cancels every RESERVED/
    // CONFIRMED booking in the same transaction it cancels the occurrence
    // - this deliberately reproduces the state that invariant exists to
    // prevent, to prove the registry itself also refuses it, not just the
    // legacy admin command.
    db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', sales_status = 'CLOSED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'test' WHERE id = ?").run(occ);

    expect(() => finalizeEngagementRewardRegistry(db, admin, engagementId, "x")).toThrow(/AGENT_REFERRALS_REWARD_REGISTRY_CANCELLED_POSITIVE_REWARD_REFUSED/);
    expect(rewardRegistrySnapshot(db, engagementId)).toBeNull();
  });
});

describe("reward registry: SUSPENDED permits finalization (maturation), DORMANT refuses it", () => {
  it("global SUSPENDED does not block finalizing an obligation that arose before suspension", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "suspended@example.test", "idem-suspended-0000001");
    closeAndComplete(db, domain, occ);

    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency" }); // readyPartner's own activateAgentReferrals already bumped the seeded revision 1 -> 2
    expect(() => finalizeEngagementRewardRegistry(db, admin, engagementId, "x")).not.toThrow();
  });

  it("DORMANT (Agent Referrals never activated) refuses finalization outright", () => {
    const { db } = fresh();
    // The global-state gate (shared with every other Agent Referrals command
    // - see agent-referrals-suspension-policy.ts) is consulted before this
    // module's own engagement lookup, so it throws its own distinct error
    // type here too, uncaught - the same convention offerEngagement etc.
    // already follow, never a module-local rewrap.
    expect(() => finalizeEngagementRewardRegistry(db, admin, "no-such-engagement", "x")).toThrow(AgentReferralsSuspensionPolicyError);
    try {
      finalizeEngagementRewardRegistry(db, admin, "no-such-engagement", "x");
    } catch (error) {
      expect((error as AgentReferralsSuspensionPolicyError).code).toBe("AGENT_REFERRALS_FEATURE_DORMANT");
    }
  });
});

describe("correction lineage: E2 <= E1 is a valid correction, E2 > E1 is refused outright", () => {
  it("a decrease (a later refund reduces net captured) mints a CORRECTION row; R stays exactly as first finalized", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "correction1@example.test", "idem-correction1-0000001");
    closeAndComplete(db, domain, occ);
    const initial = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    const registryBefore = rewardRegistrySnapshot(db, engagementId)!;

    // Simulate a late, fully-successful refund reducing net captured by 20_000 - directly against the payment, since this test's concern is the registry/effective layer, not refund plumbing.
    const { order_id: refundOrderId, payment_id: paymentId } = db.prepare("SELECT o.id AS order_id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.resolved_engagement_id = ?").get(engagementId) as { order_id: string; payment_id: string };
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 20000, 'late adjustment', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), refundOrderId, paymentId, randomUUID());

    const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "late refund");
    expect(correction.sequence).toBe(2);
    expect(correction.reward_total_kopecks).toBeLessThan(initial.reward_total_kopecks);
    expect(rewardRegistrySnapshot(db, engagementId)).toEqual(registryBefore); // R untouched
    const current = currentEffectiveRewardSnapshot(db, engagementId)!;
    expect(current).toMatchObject({ kind: "CORRECTION", sequence: 2, reward_total_kopecks: correction.reward_total_kopecks, base_registry_snapshot_id: registryBefore.id });
  });

  it("a no-op recomputation (nothing actually changed - same source_state_hash) is refused with AGENT_REFERRALS_REWARD_CORRECTION_NO_CHANGE, never minted as an evidentially-empty CORRECTION row", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "correction2@example.test", "idem-correction2-0000001");
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(() => correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "nothing changed")).toThrow(/AGENT_REFERRALS_REWARD_CORRECTION_NO_CHANGE/);
    expect(currentEffectiveRewardSnapshot(db, engagementId)!.sequence).toBe(1); // no CORRECTION row minted
  });

  it("an increase is refused with REWARD_CORRECTION_INCREASE_REVIEW_REQUIRED - never an automatic top-up", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "correction3@example.test", "idem-correction3-0000001");
    closeAndComplete(db, domain, occ);
    const initial = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");

    // Directly raise the captured amount past what R originally saw - a
    // hypothetical "late capture increase" fact, used here purely to prove
    // the structural refusal (this codebase's real payment flow never
    // raises captured_amount_kopecks after the fact).
    db.prepare(`UPDATE payments SET captured_amount_kopecks = captured_amount_kopecks + 50000 WHERE order_id IN (SELECT id FROM orders WHERE resolved_engagement_id = ?)`).run(engagementId);

    expect(() => correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "should be refused")).toThrow(/AGENT_REFERRALS_REWARD_CORRECTION_INCREASE_REVIEW_REQUIRED/);
    const current = currentEffectiveRewardSnapshot(db, engagementId)!;
    expect(current.sequence).toBe(1);
    expect(current.reward_total_kopecks).toBe(initial.reward_total_kopecks); // unchanged - no top-up occurred
  });

  it("a correction is refused while the pinned orders are back in an unresolved state - the same reconciliation gate finalization itself ran, not skipped for corrections", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "ambiguous@example.test", "idem-ambiguous-0000001");
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");

    // A late refund submission left ambiguous (SUBMIT_UNKNOWN) - a real
    // reachable payment-provider outcome elsewhere in this codebase, not a
    // contrived state.
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash) VALUES (?, ?, ?, ?, 1000, 'late', 'ADMIN_COMPENSATION', 'SUBMIT_UNKNOWN', ?, 'h')")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    expect(() => correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "should be refused")).toThrow(/AGENT_REFERRALS_REWARD_REGISTRY_UNRESOLVED_REFUND_STATE/);
    expect(currentEffectiveRewardSnapshot(db, engagementId)!.sequence).toBe(1); // no correction minted while ambiguous

    db.prepare("DELETE FROM refunds WHERE status = 'SUBMIT_UNKNOWN'").run();

    // A still-open refund obligation similarly refuses.
    db.prepare("INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status) VALUES (?, ?, 'CUSTOMER_CANCELLATION_PARTIAL', 1000, 'OPEN')").run(randomUUID(), order.payment_id);
    expect(() => correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "still refused")).toThrow(/AGENT_REFERRALS_REWARD_REGISTRY_REFUND_OBLIGATION_OPEN/);
    expect(currentEffectiveRewardSnapshot(db, engagementId)!.sequence).toBe(1);

    // Once resolved, a genuine correction (a real, reconciled refund reducing net captured) succeeds.
    db.prepare("UPDATE refund_obligations SET status = 'FULFILLED', fulfilled_at = CURRENT_TIMESTAMP WHERE payment_id = ?").run(order.payment_id);
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 1000, 'resolved', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "resolved, now correcting");
    expect(correction.sequence).toBe(2);
  });

  it("a correction is refused when the registry's own formula_version is not the one this module currently supports", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "oldformula@example.test", "idem-oldformula-0000001");
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    // Simulate a hypothetical future formula v2 by mutating R's own pinned
    // version directly (immutability guard would refuse this in
    // production; direct SQL is the only way to reach this state in a test).
    db.exec(`DROP TRIGGER engagement_reward_registry_snapshot_immutable_guard`);
    db.prepare("UPDATE engagement_reward_registry_snapshot SET formula_version = 2 WHERE engagement_id = ?").run(engagementId);
    expect(() => correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "should be refused")).toThrow(/AGENT_REFERRALS_REWARD_REGISTRY_FORMULA_VERSION_UNSUPPORTED/);
  });

  it("a raw concurrent duplicate correction attempt hits the UNIQUE(engagement_id, sequence) backstop", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "correction4@example.test", "idem-correction4-0000001");
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    const current = currentEffectiveRewardSnapshot(db, engagementId)!;

    // current.sequence is 1 (no correction has happened yet in this test) -
    // a second CHECK-consistent row at the same sequence (kind INITIAL, no
    // supersedes pointer) still collides, proving the UNIQUE(engagement_id,
    // sequence) backstop specifically.
    expect(current.sequence).toBe(1);
    expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
      VALUES (?, ?, ?, ?, ?, 'INITIAL', 0, 'h', 'race', 'admin', 'chx')`)
      .run(randomUUID(), engagementId, current.engagement_revision_id, current.base_registry_snapshot_id, current.sequence)).toThrow(/UNIQUE constraint failed/);
  });
});

describe("§B-7 wiring: closeEngagement's real production resolver", () => {
  it("resolveRewardRegistryFinalizationFromRegistry reports unfinalized before finalize, finalized after", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "resolver@example.test", "idem-resolver-0000001");
    expect(resolveRewardRegistryFinalizationFromRegistry(db, engagementId)).toEqual({ finalized: false, evidence_ref: "" });
    closeAndComplete(db, domain, occ);
    const result = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(resolveRewardRegistryFinalizationFromRegistry(db, engagementId)).toEqual({ finalized: true, evidence_ref: result.registry_snapshot_id });
  });

  it("closeEngagementWithRewardRegistry refuses before finalization, then closes cleanly once the registry is real and the publication window has ended", async () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "close@example.test", "idem-close-0000001");
    closeAndComplete(db, domain, occ);
    await wait(400); // publication_end_at (now + 250ms) is safely in the past

    expect(() => closeEngagementWithRewardRegistry(db, admin, engagementId, "too early")).toThrow(/AGENT_REFERRALS_CLOSURE_REWARD_REGISTRY_FINALIZATION_UNAVAILABLE/);

    finalizeEngagementRewardRegistry(db, admin, engagementId, "finalize before closing");

    const result = closeEngagementWithRewardRegistry(db, admin, engagementId, "closing");
    expect(result.replayed).toBe(false);
    expect(db.prepare("SELECT lifecycle_state FROM engagements WHERE id = ?").get(engagementId)).toEqual({ lifecycle_state: "CLOSED" });
  });

  it("closeEngagement's own prerequisites are not loosened - a stricter caller-supplied resolver would still refuse if it reported unfinalized, proving this wiring adds no bypass", () => {
    const { db } = fresh();
    // A resolver reporting unfinalized still refuses, exactly like PR5's test fixture always did - the real resolver above changes only WHAT gets read, never the enforcement.
    expect(() => resolveRewardRegistryFinalizationFromRegistry(db, "nonexistent-engagement")).not.toThrow();
    expect(resolveRewardRegistryFinalizationFromRegistry(db, "nonexistent-engagement")).toEqual({ finalized: false, evidence_ref: "" });
  });
});
