import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../../src/db";
import { CommerceDomain } from "../../src/domain";
import { MockProvider } from "../../src/provider";
import { activateAgentReferrals } from "../../src/agent-referrals-feature-state";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../../src/agent-referrals-framework-acceptance";
import { createPartnerPromo } from "../../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../../src/agent-referrals-engagement-step-up";
import { offerEngagement, verifyAudienceForPartnerCity, acceptEngagement, activateEngagement, type EngagementRevisionTerms } from "../../src/agent-referrals-engagement";
import { setPartnerPayoutDestination } from "../../src/agent-referrals-payout-profile";
import { finalizeEngagementRewardRegistry } from "../../src/agent-referrals-reward-registry";
import { preparePartnerSettlement, type AgentReferralsSettlementRow } from "../../src/agent-referrals-settlement";
import { generateSettlementAct, presentSettlementAct, acceptSettlementAct, type SettlementActRow } from "../../src/agent-referrals-act";
import { mintSettlementStepUpGrant } from "../../src/agent-referrals-settlement-step-up";
import { recordNpdStatusCheck } from "../../src/agent-referrals-npd";

/**
 * Shared PR7 fixture chain, mirroring
 * agent-referrals-reward-registry.test.ts's local helper set exactly
 * (readyPartner/seedOccurrence/nearTermTerms/offerAcceptActivate/
 * purchaseAndPay/closeAndComplete/checkoutInput/wait) plus the additional
 * steps Phase 7 needs on top (payout profile, NPD status check, settlement/
 * act). Factored out here (commerce/test/support/, precedent:
 * concurrency-fixture.ts) rather than duplicated four times across the
 * PR7 test files, since the full chain from a fresh database to an
 * accepted act is himself the shared setup every PR7 behavior test needs
 * before it can exercise anything specific to settlement/act/payment/NPD/
 * recovery/zero-closure - that shared chain is itself the setup every PR7
 * behavior test needs.
 */

process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_ID ??= "test-payout-key-for-agent-referrals-settlement-fixtures";
process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_BASE64 ??= Buffer.alloc(32, 9).toString("base64");

export const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };
export const FAR_FUTURE = "2040-01-01T00:00:00.000Z";

const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((d) => [d, { document_id: d, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${d}`, archive_url: `https://example.test/archive/${d}`, checkout_relevant: true }])) };

export const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-settlement-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  const releaseId = randomUUID();
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(legalManifest));
  const domain = new CommerceDomain(db, new MockProvider());
  return { db, domain, path: file };
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

export type ReadyPartner = { partner: PartnerPrincipal; agentId: string; partnerIdentityId: string; cityId: string; promo: { promo_code_id: string; partner_id: string } };

/** taxMode defaults to NPD (the harder, document-lifecycle path); pass "OTHER" for the simpler act-accepted-then-MADE-is-SETTLED flow. */
export const readyPartner = (db: Database.Database, taxMode: "NPD" | "OTHER" = "NPD"): ReadyPartner => {
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  const contractorType = taxMode === "NPD" ? "SELF_EMPLOYED" : "INDIVIDUAL_ENTREPRENEUR";
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, ?, '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`, contractorType);
  const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, taxMode === "NPD" ? "INDIVIDUAL" : "INDIVIDUAL_ENTREPRENEUR", taxMode);
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

  const payoutGrant = mintStepUpGrant(db, partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: null });
  setPartnerPayoutDestination(db, partner, { step_up_grant_id: payoutGrant.grant_id, destination_kind: "BANK_CARD", destination_plaintext: "4111111111111111", destination_last4: "1111" });

  return { partner, agentId, partnerIdentityId, cityId, promo };
};

export const seedOccurrence = (db: Database.Database, cityId: string, priceKopecks = 100_000) => {
  const occurrenceId = randomUUID();
  // In the past - completeOccurrence() requires ends_at <= now().
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2020-10-01T10:00:00.000Z', '2020-10-01T13:00:00.000Z', 'Asia/Novosibirsk', ?, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId, priceKopecks);
  return occurrenceId;
};

/** publication_end_at just barely in the future - see agent-referrals-reward-registry.test.ts's identical helper for the rationale. */
export const nearTermTerms = (discountValue: number, rewardType: "PERCENT" | "FIXED" = "PERCENT", rewardValue = 1000): EngagementRevisionTerms => ({
  reward_type: rewardType, reward_value: rewardValue, customer_discount_type: "PERCENT", customer_discount_value: discountValue,
  publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: new Date(Date.now() + 250).toISOString(), terms: {},
});

export const offerAcceptActivate = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, occurrenceId: string, terms: EngagementRevisionTerms) => {
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms, "offer");
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, partner, engagementId, revisionId, grant);
  activateEngagement(db, admin, engagementId, revisionId);
  return engagementId;
};

export const checkoutInput = (quoteId: string, email: string) =>
  ({ quote_id: quoteId, customer_email: email, customer_adult_confirmed: true as const, participant_age_band: "ADULT" as const, offer_accepted: true as const, pd_consent_accepted: true as const });

export const purchaseAndPay = (db: Database.Database, domain: CommerceDomain, occurrenceId: string, promoCode: string, email: string, idem: string) => {
  const quote = domain.checkoutContext({ occurrenceId, promoCode });
  domain.checkout(checkoutInput(quote.quote_id, email), idem);
  const order = db.prepare("SELECT o.id, p.id AS payment_id, o.amount_kopecks FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.occurrence_id = ? ORDER BY o.rowid DESC LIMIT 1").get(occurrenceId) as { id: string; payment_id: string; amount_kopecks: number };
  domain.markPaymentPaid(order.payment_id, order.amount_kopecks);
  return order;
};

export const closeAndComplete = (db: Database.Database, domain: CommerceDomain, occurrenceId: string) => {
  db.prepare("UPDATE occurrences SET sales_status = 'CLOSED' WHERE id = ?").run(occurrenceId);
  domain.completeOccurrence(occurrenceId);
};

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal, genuinely LEGACY referral_rewards row: order_id is NOT NULL
 * UNIQUE REFERENCES orders(id), so a real (if minimal) order must exist
 * first - direct SQL only, since the point of the F9 partition tests is to
 * prove the DATABASE READ FILTER, not to exercise checkout again.
 */
export const seedLegacyReferralReward = (db: Database.Database, agentId: string, occurrenceId: string, amountKopecks: number) => {
  const release = db.prepare("SELECT id FROM legal_releases WHERE active = 1").get() as { id: string };
  const orderId = randomUUID();
  db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at)
    VALUES (?, ?, ?, ?, '', 'c@example.test', 'h', ?, 1, 'd', ?, '{}', 'x')`)
    .run(orderId, `${orderId}-status`, `FX-${orderId.slice(0, 8)}`, occurrenceId, amountKopecks, release.id);
  // reward_authority_kind must match the order's own (0046's referral_rewards_authority_kind_matches_order_guard) - a fresh order defaults to
  // 'LEGACY', so this row must too; historical NULL is only reachable pre-0046, already proven in agent-referrals-attribution-reward-migration.test.ts.
  db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks, reward_authority_kind) VALUES (?, ?, ?, ?, ?, 'LEGACY')")
    .run(randomUUID(), orderId, agentId, occurrenceId, amountKopecks);
  return orderId;
};

/** Closes sales, completes the occurrence, finalizes R/E1, and mints the PREPARED AGENT_REFERRALS settlement derived from E1. */
export const finalizedSettlement = (db: Database.Database, domain: CommerceDomain, occurrenceId: string, engagementId: string): AgentReferralsSettlementRow => {
  closeAndComplete(db, domain, occurrenceId);
  const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");
  const { settlement } = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
  return settlement;
};

/** Generates, presents, and accepts the act for a PREPARED settlement - the exact chain payment authorization requires. */
export const acceptedAct = (db: Database.Database, partner: PartnerPrincipal, settlement: AgentReferralsSettlementRow): SettlementActRow => {
  const { act } = generateSettlementAct(db, admin, settlement.id);
  presentSettlementAct(db, admin, act.id);
  const grant = mintSettlementStepUpGrant(db, partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id });
  acceptSettlementAct(db, partner, act.id, grant.grant_id);
  return act;
};

export const activeNpdCheck = (db: Database.Database, partnerIdentityId: string) => recordNpdStatusCheck(db, admin, partnerIdentityId, "ACTIVE", "manual-fns-check-1");

export type { AdminPrincipal, PartnerPrincipal };
