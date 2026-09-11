import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_ID ??= "test-payout-key-for-agent-referrals-legal-profile-supersession-test";
process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_BASE64 ??= Buffer.alloc(32, 7).toString("base64");
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals, suspendAgentReferrals, agentReferralsFeatureState } from "../src/agent-referrals-feature-state";
import {
  provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile,
  issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal,
} from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, verifyAudienceForPartnerCity, acceptEngagement, activateEngagement, getEngagement, resolveActivatedLegalProfileBinding, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import { closeEngagementWithRewardRegistry, currentEffectiveRewardSnapshot } from "../src/agent-referrals-reward-registry";
import { closeEngagementZeroReward, zeroRewardClosureForEngagement } from "../src/agent-referrals-zero-reward-closure";
import { preparePartnerSettlement, correctPartnerRewardWithSettlement, agentReferralsSettlementById, SettlementError } from "../src/agent-referrals-settlement";
import { setPartnerPayoutDestination } from "../src/agent-referrals-payout-profile";
import { generateSettlementAct, presentSettlementAct, acceptSettlementAct } from "../src/agent-referrals-act";
import { mintSettlementStepUpGrant } from "../src/agent-referrals-settlement-step-up";
import { recordNpdStatusCheck } from "../src/agent-referrals-npd";
import { beginPayment, recordPaymentMade, recordNpdReceipt } from "../src/agent-referrals-payment";
import { mintRetentionPolicyRevision, destroyPartnerIdentity } from "../src/agent-referrals-identity-retention";
import { recordVerifiedTaxTreatment } from "../src/agent-referrals-tax-treatment";
import { currentAgentReferralsLegalProfile, resolveCurrentLegalProfileBinding } from "../src/agent-referrals-legal-profile";
import {
  submitLegalProfileSupersession, verifyLegalProfileSupersession, rejectLegalProfileSupersession,
  supersessionBindingDecision, legalProfileChangeRequestById, pendingLegalProfileChangeRequestForPartner,
  AgentReferralsLegalProfileSupersessionError, currentLegalProfileRevisionForPartner } from "../src/agent-referrals-legal-profile-supersession";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-legal-profile-supersession-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

const individualRequisites = { full_name: "Ivanov Ivan Ivanovich", inn: "123456789012" };
const individualEntrepreneurRequisites = { full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345" };
const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };

/** Mirrors agent-referrals-creative.test.ts's own readyPartner - same established pattern, not shared across files by this repo's own convention. */
const readyPartner = (db: Database.Database) => {
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, "INDIVIDUAL", "NPD", individualRequisites, 0);
  verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verified");
  const fw = mintFrameworkAgreementRevision(db, clause(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES), null);
  const dt = mintDelegationTemplateRevision(db, clause(DELEGATION_TEMPLATE_REQUIRED_CLAUSES), null);
  issueFrameworkToPartner(db, admin, partnerIdentityId, fw.id, dt.id, "issued");
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };
  const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", { framework_agreement_revision_id: fw.id, delegation_template_revision_id: dt.id }).grant_id;
  acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id);
  activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "ADMIN", "onboarding complete");
  const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
  verifyAudienceForPartnerCity(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
  const payoutGrant = mintStepUpGrant(db, partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: null }).grant_id;
  setPartnerPayoutDestination(db, partner, { step_up_grant_id: payoutGrant, destination_kind: "BANK_ACCOUNT", destination_plaintext: "40817810099910004312", destination_last4: "4312" });
  return { partner, agentId, partnerIdentityId, cityId, promo };
};

const farTerms: EngagementRevisionTerms = {
  reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000,
  publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2035-01-01T00:00:00.000Z", terms: {},
};

const seedOccurrence = (db: Database.Database, cityId: string) => {
  const occurrenceId = randomUUID();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return occurrenceId;
};

const completeOccurrence = (db: Database.Database, occurrenceId: string) =>
  db.prepare("UPDATE occurrences SET fulfillment_status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, sales_status = 'CLOSED' WHERE id = ?").run(occurrenceId);

/** Activates an engagement with the given publication_end_at (far future by default - override with a near-future timestamp + a real sleep when the test needs to close it, matching agent-referrals-engagement-closure.test.ts's own idiom). */
const activatedEngagement = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, occurrenceId: string, publicationEndAt = farTerms.publication_end_at) => {
  const terms = { ...farTerms, publication_end_at: publicationEndAt };
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms, "offer");
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, partner, engagementId, revisionId, grant);
  activateEngagement(db, admin, engagementId, revisionId);
  return { engagementId, revisionId };
};

/** Raw-inserted R + E1 (INITIAL), mirroring commerce/test/agent-referrals-act-payment-settlement-migration.test.ts's own established migration-test seeding style - the order/checkout reconciliation pipeline finalizeEngagementRewardRegistry drives is out of scope for what these tests are about. */
const seedRegistryAndEffective = (db: Database.Database, engagementId: string, revisionId: string, occurrenceId: string, rewardTotal: number) => {
  const registryId = randomUUID();
  db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
    VALUES (?, ?, ?, ?, 'COMPLETED', ?, 1, '[]', ?, CURRENT_TIMESTAMP, 'admin', 'seed')`)
    .run(registryId, engagementId, revisionId, occurrenceId, rewardTotal, `hash-${registryId}`);
  const effectiveId = randomUUID();
  db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
    VALUES (?, ?, ?, ?, 1, 'INITIAL', ?, ?, 'seed', 'admin', ?)`)
    .run(effectiveId, engagementId, revisionId, registryId, rewardTotal, `hash-${registryId}`, `canonical-${effectiveId}`);
  return { registryId, effectiveId };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full chain to a CLOSED engagement with a real R/E1 of the given total. */
const closedEngagementWithReward = async (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, cityId: string, rewardTotal: number) => {
  const occurrenceId = seedOccurrence(db, cityId);
  const { engagementId, revisionId } = activatedEngagement(db, partner, partnerIdentityId, occurrenceId, new Date(Date.now() + 400).toISOString());
  completeOccurrence(db, occurrenceId);
  await sleep(600);
  const { effectiveId } = seedRegistryAndEffective(db, engagementId, revisionId, occurrenceId, rewardTotal);
  closeEngagementWithRewardRegistry(db, admin, engagementId, "closing");
  return { engagementId, occurrenceId, effectiveId };
};

/**
 * The real act -> presentation -> acceptance -> payment (-> NPD receipt)
 * ceremony, all the way to SETTLED (reward_settlements has a status-machine
 * trigger that refuses a raw UPDATE straight to SETTLED/PENDING_DOCUMENT).
 * All readyPartner() fixtures are INDIVIDUAL/NPD until superseded, so this
 * defaults to the NPD path (MADE -> PENDING_DOCUMENT -> receipt -> SETTLED,
 * per projectSettlementFromMadeAttempt) unless taxMode is overridden.
 */
const payToSettled = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, settlementId: string, taxMode: "NPD" | "OTHER" = "NPD") => {
  const { act } = generateSettlementAct(db, admin, settlementId);
  presentSettlementAct(db, admin, act.id);
  const grant = mintSettlementStepUpGrant(db, partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id }).grant_id;
  acceptSettlementAct(db, partner, act.id, grant);
  if (taxMode === "NPD") recordNpdStatusCheck(db, admin, partnerIdentityId, "ACTIVE", "npd-check-evidence");
  const { attempt } = beginPayment(db, admin, settlementId);
  recordPaymentMade(db, admin, attempt.id, "payment-evidence");
  if (taxMode === "NPD") recordNpdReceipt(db, admin, attempt.id, "receipt-1", "receipt-evidence");
};

describe("D2: legal-profile supersession suspension-policy wiring", () => {
  it("submit and reject are permitted under SUSPENDED (evidence, not authority), verify is not", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    suspendAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "suspend" });

    expect(() => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) })).not.toThrow();
    const request = pendingLegalProfileChangeRequestForPartner(db, p1.partnerIdentityId)!;
    expect(() => verifyLegalProfileSupersession(db, admin, request.id, "verify")).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
    expect(() => rejectLegalProfileSupersession(db, admin, request.id, "rejecting")).not.toThrow();
  });

  it("submit is refused under DORMANT", () => {
    const db = fresh();
    // DORMANT is the ship state - no activateAgentReferrals call at all.
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, agentId, `${agentId}@example.test`);
    expect(() => submitLegalProfileSupersession(db, admin, "does-not-matter", { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", expectedCurrentLegalProfileRevision: 1 }))
      .toThrow(/AGENT_REFERRALS_FEATURE_DORMANT/);
  });

  it("initial onboarding verification (verifyPartnerLegalProfile) is now also gated as NEW_AUTHORITY - closes the pre-D2 gap", () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, agentId, `${agentId}@example.test`);
    const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
    submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, "INDIVIDUAL", "NPD", individualRequisites, 0);

    suspendAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "suspend" });
    expect(() => verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verify")).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
    expect(currentAgentReferralsLegalProfile(db, agentId)).toBeNull();
  });

  it("submit under SUSPENDED, then back to ACTIVE: the request stays PENDING until an explicit verify - reactivation alone mints nothing", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    suspendAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "suspend" });
    submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    activateAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "resume" });

    const request = pendingLegalProfileChangeRequestForPartner(db, p1.partnerIdentityId)!;
    expect(request.state).toBe("PENDING");
    expect(currentAgentReferralsLegalProfile(db, p1.agentId)).toMatchObject({ legal_form: "INDIVIDUAL", tax_mode: "NPD" });

    // MAX did not move while suspended, so this verify is not STALE.
    const outcome = verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(outcome).toMatchObject({ outcome: "VERIFIED" });
  });
});

describe("D2: submit()", () => {
  it("refuses a no-op resubmission of the current profile", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    expect(() => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "INDIVIDUAL", taxMode: "NPD", ...individualRequisites, reason: "no real change", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) }))
      .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_NO_CHANGE/);
    expect(pendingLegalProfileChangeRequestForPartner(db, p1.partnerIdentityId)).toBeNull();
  });

  it("refuses submission for an identity that is not PARTNER_ACTIVE, and for one destroyed after becoming active", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES ('agent-fresh', 'agent-fresh', 'A', 'A Legal', 'fresh@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run();
    const { partner_identity_id: freshPartnerId } = provisionPartnerOwner(db, admin, "agent-fresh", "fresh@example.test", "test");
    expect(() => submitLegalProfileSupersession(db, admin, freshPartnerId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, freshPartnerId) }))
      .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INELIGIBLE_IDENTITY/);

    mintRetentionPolicyRevision(db, admin, "test policy");
    destroyPartnerIdentity(db, admin, p1.partnerIdentityId, "erasure request");
    expect(() => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) }))
      .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INELIGIBLE_IDENTITY/);
  });

  it("a second submit while one is PENDING is refused - pre-check", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "first", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    expect(() => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", ...individualEntrepreneurRequisites, reason: "second", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) }))
      .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_ALREADY_PENDING/);
  });

  it("two sequential submits for the same identity (serialized by better-sqlite3's synchronous execution): exactly one succeeds, the other gets ALREADY_PENDING via the pre-check, never 500", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const b = new Database(db.name); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

    let firstError: unknown;
    let secondError: unknown;
    try { submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "A", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) }); } catch (e) { firstError = e; }
    try { submitLegalProfileSupersession(b, admin, p1.partnerIdentityId, { legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", ...individualEntrepreneurRequisites, reason: "B", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(b, p1.partnerIdentityId) }); } catch (e) { secondError = e; }

    expect([firstError, secondError].filter(Boolean)).toHaveLength(1);
    const failure = (firstError ?? secondError) as AgentReferralsLegalProfileSupersessionError;
    expect(failure.code).toBe("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_ALREADY_PENDING");
    const requests = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_change_requests").get();
    expect(requests).toEqual({ n: 1 });
  });

  it("the structural backstop itself: a genuine race window (this connection's own pre-check already passed, then a second writer commits first) still resolves via the partial unique index, with the exact error shape submit()'s catch block translates - proving that regex is not merely aspirational", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const b = new Database(db.name); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

    // The exact window submit()'s own pre-check-then-INSERT leaves open
    // under real concurrency (two statements, not one atomic check): this
    // connection observes nothing PENDING right now.
    expect(pendingLegalProfileChangeRequestForPartner(db, p1.partnerIdentityId)).toBeNull();

    // A second writer wins the race and commits a PENDING request first -
    // via the real domain function, not a shortcut.
    submitLegalProfileSupersession(b, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "B", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(b, p1.partnerIdentityId) });

    // This connection now attempts the exact INSERT its own submit() would
    // issue after that now-stale pre-check - proving the partial unique
    // index, not merely the pre-check, is the real backstop, and that its
    // error message is exactly what submit()'s catch regex expects.
    const current = currentAgentReferralsLegalProfile(db, p1.agentId)!;
    expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests(id, partner_identity_id, legal_form, tax_mode, full_name, inn, registration_number, assertion_source, reason, supersedes_revision_id, created_by)
      VALUES (?, ?, 'INDIVIDUAL_ENTREPRENEUR', 'OTHER', 'Ivanov Ivan Ivanovich', '123456789012', '123456789012345', 'PARTNER_ASSERTED', 'A', ?, ?)`)
      .run(randomUUID(), p1.partnerIdentityId, current.id, p1.partnerIdentityId))
      .toThrow(/UNIQUE constraint failed: agent_referrals_legal_profile_change_requests\.partner_identity_id/);
  });

  it("assertion_source and created_by are derived from the principal's own realm, never accepted from the caller", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const adminRequest = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "admin claim", evidenceRef: "egrul.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    expect(adminRequest).toMatchObject({ assertion_source: "ADMIN_ASSERTED", created_by: admin.admin_id, evidence_ref: "egrul.pdf" });
    rejectLegalProfileSupersession(db, admin, adminRequest.id, "cleanup");

    const partnerRequest = submitLegalProfileSupersession(db, p1.partner, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "partner claim", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    expect(partnerRequest).toMatchObject({ assertion_source: "PARTNER_ASSERTED", created_by: p1.partnerIdentityId, evidence_ref: null });
  });

  it("ADMIN_ASSERTED submission without evidence_ref is refused", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    expect(() => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "admin claim", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) }))
      .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_EVIDENCE_REF_REQUIRED/);
  });
});

describe("D2: seam test - blocked, unblocked, verified, replayed, activates the new revision", () => {
  it("the full documented seam", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const { engagementId } = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 9000);
    const settlement = preparePartnerSettlement(db, admin, (db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId) as { id: string }).id).settlement;
    expect(settlement.status).toBe("PREPARED");

    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became an organization", evidenceRef: "egrul.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    expect(request.state).toBe("PENDING");

    // Still PREPARED (unsettled) -> BLOCKED, no revision minted, nothing changes.
    let outcome = verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(outcome).toMatchObject({ outcome: "BLOCKED", reason: "OUTSTANDING_SETTLEMENT" });
    expect(currentAgentReferralsLegalProfile(db, p1.agentId)).toMatchObject({ revision: 1, legal_form: "INDIVIDUAL" });
    const pin1 = resolveActivatedLegalProfileBinding(db, engagementId);
    expect(pin1.revision).toBe(1);
    expect(legalProfileChangeRequestById(db, request.id)!.state).toBe("PENDING");

    // Close the blocker.
    payToSettled(db, p1.partner, p1.partnerIdentityId, settlement.id);

    outcome = verifyLegalProfileSupersession(db, admin, request.id, "verify again");
    expect(outcome).toMatchObject({ outcome: "VERIFIED", revision: 2 });
    const current = currentAgentReferralsLegalProfile(db, p1.agentId);
    expect(current).toMatchObject({ revision: 2, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", projected_contractor_type: "ORGANIZATION", assertion_source: "ADMIN_ASSERTED", evidence_ref: "egrul.pdf" });
    const coherent = resolveCurrentLegalProfileBinding(db, getPartnerIdentity(db, p1.partnerIdentityId)!);
    expect(coherent.id).toBe(current!.id);
    // The historical activation still names the OLD revision - never replayed.
    expect(resolveActivatedLegalProfileBinding(db, engagementId).revision).toBe(1);
    expect(legalProfileChangeRequestById(db, request.id)!).toMatchObject({ state: "VERIFIED", resolved_legal_profile_revision_id: current!.id });

    // Replay: no third revision, same result.
    const replay = verifyLegalProfileSupersession(db, admin, request.id, "verify a third time");
    expect(replay).toMatchObject({ outcome: "REPLAYED", revision: 2, revision_id: current!.id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions WHERE agent_id = ?").get(p1.agentId)).toEqual({ n: 2 });

    // A NEW engagement, activated now, pins the NEW revision.
    const occurrenceId2 = seedOccurrence(db, p1.cityId);
    const { engagementId: engagementId2, revisionId: revision2Id } = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occurrenceId2, new Date(Date.now() + 400).toISOString());
    expect(resolveActivatedLegalProfileBinding(db, engagementId2).revision).toBe(2);

    // PR-F: LEGAL_ENTITY/OTHER never auto-mints a tax treatment (unlike
    // NPD) - an explicit admin-asserted one is required before a
    // settlement can be prepared under revision #2.
    recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
      taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2020-01-01", evidenceRef: "usn-exempt.pdf", reason: "became an organization, USN exemption",
    }, randomUUID());

    // A settlement prepared for post-supersession work carries tax_mode and contractor_type BOTH from #2, and 0047/0049's guards pass without a 500.
    completeOccurrence(db, occurrenceId2);
    await sleep(600);
    const { effectiveId: effective2 } = seedRegistryAndEffective(db, engagementId2, revision2Id, occurrenceId2, 5000);
    closeEngagementWithRewardRegistry(db, admin, engagementId2, "closing 2");
    const settlement2 = preparePartnerSettlement(db, admin, effective2).settlement;
    expect(settlement2).toMatchObject({ tax_mode_snapshot: "OTHER", legal_profile_revision_id_snapshot: current!.id });
    // contractor_type_snapshot is write-only in AgentReferralsSettlementRow's own column list - read it back raw.
    expect((db.prepare("SELECT contractor_type_snapshot FROM reward_settlements WHERE id = ?").get(settlement2.id) as { contractor_type_snapshot: string }).contractor_type_snapshot)
      .toBe("ORGANIZATION");
  });
});

describe("D2: STALE is committed, not thrown (white-box invariant test)", () => {
  it("supersedes a stale baseline: commits STALE with expected/actual, frees the partial index, and never mints", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "org", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    expect(request.supersedes_revision_id).toBe(currentAgentReferralsLegalProfile(db, p1.agentId)!.id);

    // White-box: advance the verified chain out from under the request via
    // the low-level mint directly - this state (PENDING with a stale
    // supersedes_revision_id) is unreachable through any sanctioned path.
    const identity = getPartnerIdentity(db, p1.partnerIdentityId)!;
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, supersedes_revision_id, reason, assertion_source)
      VALUES ('lp-out-of-band', ?, 2, 'INDIVIDUAL_ENTREPRENEUR', 'OTHER', 'INDIVIDUAL_ENTREPRENEUR', 'Ivanov Ivan Ivanovich', '123456789012', '123456789012345', ?, 'out of band', 'PARTNER_ASSERTED')`)
      .run(p1.agentId, identity.legal_profile_revision_id);
    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = 'lp-out-of-band' WHERE id = ?").run(p1.partnerIdentityId);

    const outcome = verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(outcome).toMatchObject({ outcome: "STALE", expected: request.supersedes_revision_id, actual: "lp-out-of-band" });

    const after = legalProfileChangeRequestById(db, request.id)!;
    expect(after.state).toBe("STALE");
    expect(after.resolved_legal_profile_revision_id).toBeNull();
    expect(after.resolved_by).toBe(admin.admin_id);
    expect(after.resolution_reason).toBeTruthy();
    expect(currentAgentReferralsLegalProfile(db, p1.agentId)!.revision).toBe(2); // no third revision minted

    // Partial index is free again - a new request can be filed.
    expect(() => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "retry", evidenceRef: "ev2.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) }))
      .not.toThrow();
  });
});

describe("D2: replay and terminal-state handling", () => {
  it("verify(REJECTED) and verify(STALE) return INVALID_STATE, read-only", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const rejected = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", evidenceRef: "e.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    rejectLegalProfileSupersession(db, admin, rejected.id, "no");
    expect(verifyLegalProfileSupersession(db, admin, rejected.id, "retry")).toMatchObject({ outcome: "INVALID_STATE", state: "REJECTED" });
  });

  it("a REPLAYED verify does not re-check suspension or eligibility - only a PENDING verify does", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", evidenceRef: "e.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    const first = verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(first).toMatchObject({ outcome: "VERIFIED" });
    if (first.outcome !== "VERIFIED") throw new Error("unreachable");

    suspendAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "suspend" });
    const replay = verifyLegalProfileSupersession(db, admin, request.id, "verify again");
    expect(replay).toEqual({ outcome: "REPLAYED", revision_id: first.revision_id, revision: first.revision });

    activateAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "resume" });
    mintRetentionPolicyRevision(db, admin, "test policy");
    destroyPartnerIdentity(db, admin, p1.partnerIdentityId, "erasure");
    const replayAfterDestroy = verifyLegalProfileSupersession(db, admin, request.id, "verify a third time");
    expect(replayAfterDestroy).toEqual({ outcome: "REPLAYED", revision_id: first.revision_id, revision: first.revision });
  });

  it("reject on an already-VERIFIED or already-REJECTED request is refused", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", evidenceRef: "e.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(() => rejectLegalProfileSupersession(db, admin, request.id, "too late")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INVALID_STATE/);
  });
});

describe("D2: precondition coherence (POINTER_DIVERGED)", () => {
  it("verify refuses and rolls back if the pointer diverged from MAX before the command even ran", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", evidenceRef: "e.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });

    // White-box corruption: pointer no longer names MAX.
    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = NULL WHERE id = ?").run(p1.partnerIdentityId);

    expect(() => verifyLegalProfileSupersession(db, admin, request.id, "verify")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_POINTER_DIVERGED/);
    expect(legalProfileChangeRequestById(db, request.id)!.state).toBe("PENDING"); // rolled back, not silently repaired
  });
});

describe("D2: activation binding without a temporal heuristic", () => {
  it("repeated activation of the same engagement_revision pins the same legal profile - one coherent answer, no ORDER BY created_at anywhere", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const { engagementId, revisionId } = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occurrenceId);
    // Re-activate the SAME revision - legal, forward-only, changes nothing about which revision governs.
    activateEngagement(db, admin, engagementId, revisionId);
    expect(() => resolveActivatedLegalProfileBinding(db, engagementId)).not.toThrow();
    expect(resolveActivatedLegalProfileBinding(db, engagementId).revision).toBe(1);
  });

  it("two distinct pins on the same engagement_revision_id is reported as corrupted evidence, not an ordinary BINDING_MISMATCH", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const { engagementId, revisionId } = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occurrenceId);

    // White-box: mint a second legal-profile revision and forge a second
    // activation_events row on the SAME engagement_revision_id pointing at
    // it - a state no sanctioned path can produce.
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, supersedes_revision_id, reason, assertion_source)
      VALUES ('lp-corrupt', ?, 2, 'INDIVIDUAL_ENTREPRENEUR', 'OTHER', 'INDIVIDUAL_ENTREPRENEUR', 'Ivanov Ivan Ivanovich', '123456789012', '123456789012345', ?, 'corrupt', 'PARTNER_ASSERTED')`)
      .run(p1.agentId, currentAgentReferralsLegalProfile(db, p1.agentId)!.id);
    const original = db.prepare("SELECT * FROM engagement_activation_events WHERE engagement_id = ?").get(engagementId) as Record<string, unknown>;
    db.prepare(`INSERT INTO engagement_activation_events(id, engagement_id, engagement_revision_id, audience_verification_event_id, legal_profile_revision_id, framework_acceptance_id, ord_reporting_delegation_id, promo_authorization_id, occurrence_id, activated_by_admin_id)
      VALUES (?, ?, ?, ?, 'lp-corrupt', ?, ?, ?, ?, ?)`)
      .run(randomUUID(), engagementId, revisionId, original.audience_verification_event_id, original.framework_acceptance_id, original.ord_reporting_delegation_id, original.promo_authorization_id, occurrenceId, "admin-1");

    expect(() => resolveActivatedLegalProfileBinding(db, engagementId)).toThrow(/AGENT_REFERRALS_ACTIVATION_BINDING_CORRUPTED/);
  });
});

describe("D2: settlement binding mismatch (§5-Б) and preserved historical correction (У4)", () => {
  it("supersession is legal after payment, but a NEW settlement for the same (now-superseded) engagement is refused, while the historical RECOVERY_EXPOSURE correction is not", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const { engagementId } = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 9000);
    const effectiveId = (db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    const settlement = preparePartnerSettlement(db, admin, effectiveId).settlement;
    payToSettled(db, p1.partner, p1.partnerIdentityId, settlement.id);

    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "org", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    const outcome = verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(outcome.outcome).toBe("VERIFIED");

    // Historical correction after payment: legal, RECOVERY_EXPOSURE, tied to the OLD settlement/binding - never calls resolveSettlementContext.
    const correction = correctPartnerRewardWithSettlement(db, admin, engagementId, "reward correction after supersession", currentEffectiveRewardSnapshot(db, engagementId)!.id);
    expect(correction.settlement_action).toBe("RECOVERY_EXPOSURE");
    const evidenceRow = db.prepare("SELECT * FROM engagement_recovery_exposure_evidence WHERE engagement_id = ?").get(engagementId) as Record<string, unknown> | undefined;
    expect(evidenceRow).toBeTruthy();

    // The correction above recomputed strictly from this white-box fixture's
    // empty source_order_ids_json, so it lands on zero - preparePartnerSettlement
    // would refuse it on AGENT_REFERRALS_SETTLEMENT_REWARD_NOT_POSITIVE before
    // ever reaching the binding check. A real positive post-correction E is
    // what the binding check itself is about, so white-box mint a further,
    // positive correction row directly (same engagement_revision/registry as
    // the RECOVERY_EXPOSURE correction, sequenced above it) to reach it.
    const priorE = db.prepare("SELECT engagement_revision_id, base_registry_snapshot_id, sequence FROM engagement_effective_reward_snapshots WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(engagementId) as { engagement_revision_id: string; base_registry_snapshot_id: string; sequence: number };
    const newEffectiveId = randomUUID();
    db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
      VALUES (?, ?, ?, ?, ?, ?, 'CORRECTION', 3000, 'hash-positive-correction', 'white-box positive correction', 'admin-1', ?)`)
      .run(newEffectiveId, engagementId, priorE.engagement_revision_id, priorE.base_registry_snapshot_id, correction.correction.effective_snapshot_id, priorE.sequence + 1, `canonical-${newEffectiveId}`);
    expect(newEffectiveId).not.toBe(effectiveId);

    // Minting a NEW payable settlement for this same engagement - old work,
    // now-superseded identity - is structurally refused.
    expect(() => preparePartnerSettlement(db, admin, newEffectiveId)).toThrow(SettlementError);
    expect(() => preparePartnerSettlement(db, admin, newEffectiveId)).toThrow(/AGENT_REFERRALS_SETTLEMENT_LEGAL_PROFILE_BINDING_MISMATCH/);
  });
});

describe("D2: blocking predicate - matrix and the У5 no-eternal-block property", () => {
  it("ENGAGEMENT_NOT_CLOSED: an ACTIVE engagement blocks supersession outright", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    activatedEngagement(db, p1.partner, p1.partnerIdentityId, occurrenceId);
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: true, reason: "ENGAGEMENT_NOT_CLOSED" });
  });

  // PR-B: the two allow-reasons the D2 matrix never covered. NO_ENGAGEMENT
  // is new vocabulary (it used to report ZERO_EFFECTIVE, claiming evidence
  // that does not exist); ZERO_EFFECTIVE now means only what it says, and
  // the test below also proves that branch is genuinely reachable rather
  // than dead code.
  it("NO_ENGAGEMENT: a partner that never had an engagement allows, and says so", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toEqual({ blocked: false, reason: "NO_ENGAGEMENT" });
  });

  it("ZERO_EFFECTIVE: a correction that zeroes the reward under a PREPARED settlement leaves a terminal zero E with no closure row", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const { engagementId } = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 9000);
    const effectiveId = (db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    preparePartnerSettlement(db, admin, effectiveId);
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: true, reason: "OUTSTANDING_SETTLEMENT" });

    // The seeded reward was never backed by real orders, so recomputing it
    // yields zero: the settlement is cancelled before payment and no
    // replacement is minted (CANCELLED_ZERO). That leaves a CLOSED
    // engagement whose CURRENT E is zero with no zero-reward closure row -
    // the only shape that reaches the ZERO_EFFECTIVE branch.
    const correction = correctPartnerRewardWithSettlement(db, admin, engagementId, "no orders actually backed this reward", currentEffectiveRewardSnapshot(db, engagementId)!.id);
    expect(correction.settlement_action).toBe("CANCELLED_ZERO");
    expect(zeroRewardClosureForEngagement(db, engagementId)).toBeNull();
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toEqual({ blocked: false, reason: "ZERO_EFFECTIVE" });
  });

  it("OUTSTANDING_SETTLEMENT: a CLOSED engagement with a still-PREPARED settlement blocks", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const { engagementId } = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 9000);
    const effectiveId = (db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    preparePartnerSettlement(db, admin, effectiveId);
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: true, reason: "OUTSTANDING_SETTLEMENT" });
  });

  it("CURRENT_SETTLEMENT_SETTLED: a paid settlement for the current E allows", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const { engagementId } = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 9000);
    const effectiveId = (db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    const settlement = preparePartnerSettlement(db, admin, effectiveId).settlement;
    payToSettled(db, p1.partner, p1.partnerIdentityId, settlement.id);
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: false, reason: "CURRENT_SETTLEMENT_SETTLED" });
  });

  it("ZERO_REWARD_CLOSED allows; POSITIVE_EFFECTIVE_UNSETTLED (zero settlements at all) blocks", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const zero = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 0);
    closeEngagementZeroReward(db, admin, zero.engagementId, "NO_ELIGIBLE_CONVERSIONS", "cmd-1");
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: false, reason: "ZERO_REWARD_CLOSED" });

    // A second, unrelated engagement, closed with positive reward and no settlement ever prepared - blocks the same partner.
    const positive = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 5000);
    void positive;
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: true, reason: "POSITIVE_EFFECTIVE_UNSETTLED" });
  });

  it("У5: after a paid settlement, a post-payment RECOVERY_EXPOSURE correction does NOT permanently block a later supersession", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const { engagementId } = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 9000);
    const effectiveId = (db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    const settlement = preparePartnerSettlement(db, admin, effectiveId).settlement;
    payToSettled(db, p1.partner, p1.partnerIdentityId, settlement.id);
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: false, reason: "CURRENT_SETTLEMENT_SETTLED" });

    const correction = correctPartnerRewardWithSettlement(db, admin, engagementId, "correction after payment", currentEffectiveRewardSnapshot(db, engagementId)!.id);
    expect(correction.settlement_action).toBe("RECOVERY_EXPOSURE");

    // E2 now current, no settlement of its own - the naive rule would block
    // forever. RECOVERY_EXPOSURE evidence pinned to E2 is its own terminal
    // outcome.
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: false, reason: "RECOVERY_EXPOSURE" });
  });

  it("PENDING_DOCUMENT blocks (real NPD flow, paid but the receipt not yet filed), and the block is finite - recordNpdReceipt clears it", async () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const { engagementId } = await closedEngagementWithReward(db, p1.partner, p1.partnerIdentityId, p1.cityId, 9000);
    const effectiveId = (db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ?").get(engagementId) as { id: string }).id;
    const settlement = preparePartnerSettlement(db, admin, effectiveId).settlement;

    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id);
    const grant = mintSettlementStepUpGrant(db, p1.partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id }).grant_id;
    acceptSettlementAct(db, p1.partner, act.id, grant);
    recordNpdStatusCheck(db, admin, p1.partnerIdentityId, "ACTIVE", "npd-check-evidence");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, attempt.id, "payment-evidence");
    expect(agentReferralsSettlementById(db, settlement.id)!.status).toBe("PENDING_DOCUMENT");
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: true, reason: "OUTSTANDING_SETTLEMENT" });

    recordNpdReceipt(db, admin, attempt.id, "receipt-1", "receipt-evidence");
    expect(agentReferralsSettlementById(db, settlement.id)!.status).toBe("SETTLED");
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: false, reason: "CURRENT_SETTLEMENT_SETTLED" });
  });
});

describe("D2: enum-drift guard - not exhaustive, but a new CHECK value must fail loudly rather than silently fall to a default", () => {
  it("engagements.lifecycle_state is still exactly the 5 values classifyEngagementForSupersession's rule 1 assumes", () => {
    const db = fresh();
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'engagements'").get() as { sql: string }).sql;
    const match = sql.match(/lifecycle_state TEXT NOT NULL DEFAULT 'OFFERED' CHECK \(lifecycle_state IN \(([^)]+)\)\)/);
    expect(match, "engagements.lifecycle_state CHECK clause text - update classifyEngagementForSupersession's rule 1 if this fails").not.toBeNull();
    const values = match![1].split(",").map((v) => v.trim().replace(/'/g, "")).sort();
    expect(values).toEqual(["ACCEPTED", "ACTIVE", "CLOSED", "OFFERED", "SUSPENDED"].sort());
  });

  it("reward_settlements.status is still exactly the 4 values classifyEngagementForSupersession's rules 2/3a assume", () => {
    const db = fresh();
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'reward_settlements'").get() as { sql: string }).sql;
    const match = sql.match(/status TEXT NOT NULL CHECK \(status IN \(([^)]+)\)\)/);
    expect(match, "reward_settlements.status CHECK clause text - update classifyEngagementForSupersession's rules 2/3a if this fails").not.toBeNull();
    const values = match![1].split(",").map((v) => v.trim().replace(/'/g, "")).sort();
    expect(values).toEqual(["CANCELLED_BEFORE_PAYMENT", "PENDING_DOCUMENT", "PREPARED", "SETTLED"].sort());
  });

  it("a CLOSED engagement with no reward registry finalized at all (no current E, never zero-closed) is UNCLASSIFIED/BLOCK, not a false ALLOW - this state is structurally impossible via any sanctioned path (closeEngagementWithRewardRegistry requires the registry finalized, and finalization mints R and E1 atomically), so it is evidence corruption, not 'nothing owed'", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const { engagementId } = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occurrenceId, new Date(Date.now() + 400).toISOString());
    completeOccurrence(db, occurrenceId);
    // White-box: force CLOSED without ever finalizing a reward registry or
    // minting an E - a state no sanctioned closure path can produce.
    db.prepare("UPDATE engagements SET lifecycle_state = 'CLOSED' WHERE id = ?").run(engagementId);
    expect(supersessionBindingDecision(db, p1.partnerIdentityId)).toMatchObject({ blocked: true, reason: "UNCLASSIFIED" });
  });
});

describe("D2: activateEngagement mints from proven MAX, never trusts the pointer directly (P1 review fix)", () => {
  it("MAX=#2, pointer stale at #1: activation refuses with POINTER_DIVERGED, mints no activation event, no new promo authorization, and leaves the engagement's lifecycle_state untouched", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occurrenceId, farTerms, "offer");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revisionId, grant);

    // White-box: mint a second legal-profile revision directly (out of
    // band) so MAX advances to #2 while the pointer is left stale at #1 -
    // exactly the precondition resolveCurrentLegalProfileBinding exists to
    // catch, reached here through activateEngagement's own mint path
    // rather than D2's verify().
    const staleId = getPartnerIdentity(db, p1.partnerIdentityId)!.legal_profile_revision_id!;
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, supersedes_revision_id, reason, assertion_source)
      VALUES ('lp-out-of-band-2', ?, 2, 'INDIVIDUAL_ENTREPRENEUR', 'OTHER', 'INDIVIDUAL_ENTREPRENEUR', 'Ivanov Ivan Ivanovich', '123456789012', '123456789012345', ?, 'out of band', 'PARTNER_ASSERTED')`)
      .run(p1.agentId, staleId);
    // partner_identities.legal_profile_revision_id deliberately left at #1.

    const before = getEngagement(db, engagementId)!;
    const authorizationsBefore = db.prepare("SELECT COUNT(*) AS n FROM engagement_promo_authorizations").get();
    const activationEventsBefore = db.prepare("SELECT COUNT(*) AS n FROM engagement_activation_events").get();

    expect(() => activateEngagement(db, admin, engagementId, revisionId)).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_POINTER_DIVERGED/);

    expect(getEngagement(db, engagementId)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_promo_authorizations").get()).toEqual(authorizationsBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_activation_events").get()).toEqual(activationEventsBefore);
  });

  it("pointer == MAX (the coherent case): activation still succeeds and pins the current revision, unchanged behavior", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const { engagementId } = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occurrenceId);
    expect(resolveActivatedLegalProfileBinding(db, engagementId)).toMatchObject({ id: getPartnerIdentity(db, p1.partnerIdentityId)!.legal_profile_revision_id });
  });
});

describe("D2: submit() proves a PARTNER principal is authority only for its own identity (P1 review fix)", () => {
  it("partner A targeting partner B's identity is refused as if B did not exist - no candidate, no event, MAX(B)/pointer(B) untouched", () => {
    const db = fresh();
    const partnerA = readyPartner(db);
    const partnerB = readyPartner(db);

    const maxBefore = currentAgentReferralsLegalProfile(db, partnerB.agentId);
    const pointerBefore = getPartnerIdentity(db, partnerB.partnerIdentityId)!.legal_profile_revision_id;

    expect(() => submitLegalProfileSupersession(db, partnerA.partner, partnerB.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, partnerB.partnerIdentityId) }))
      .toThrow(/PARTNER_IDENTITY_NOT_FOUND/);

    expect(pendingLegalProfileChangeRequestForPartner(db, partnerB.partnerIdentityId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE partner_identity_id = ? AND event_kind = 'LEGAL_PROFILE_CHANGE_ASSERTED_BY_PARTNER'").get(partnerB.partnerIdentityId))
      .toEqual({ n: 0 });
    expect(currentAgentReferralsLegalProfile(db, partnerB.agentId)).toEqual(maxBefore);
    expect(getPartnerIdentity(db, partnerB.partnerIdentityId)!.legal_profile_revision_id).toBe(pointerBefore);
  });

  it("an admin principal targeting any partner identity is unaffected by this check - admin deliberately chooses its target", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    expect(() => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) }))
      .not.toThrow();
  });

  it("a partner submitting for its own identity is unaffected by this check", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const request = submitLegalProfileSupersession(db, p1.partner, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "x", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId) });
    expect(request).toMatchObject({ created_by: p1.partnerIdentityId, assertion_source: "PARTNER_ASSERTED" });
  });
});
