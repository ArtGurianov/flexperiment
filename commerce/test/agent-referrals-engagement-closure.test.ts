import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { verifyAudience } from "../src/agent-referrals-audience-verification";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, acceptEngagement, activateEngagement, getEngagement } from "../src/agent-referrals-engagement";
import { closeEngagement, EngagementClosureError, type RewardRegistryFinalizationEvidence } from "../src/agent-referrals-engagement-closure";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); vi.useRealTimers(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-closure-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
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
  verifyAudience(db, admin, partnerIdentityId, cityId, "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
  return { partner, agentId, partnerIdentityId, cityId, promo };
};

const seedOccurrence = (db: Database.Database, cityId: string) => {
  const occurrenceId = randomUUID();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`)
    .run(occurrenceId, cityId);
  return occurrenceId;
};

const completeOccurrence = (db: Database.Database, occurrenceId: string) =>
  db.prepare("UPDATE occurrences SET fulfillment_status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, sales_status = 'CLOSED' WHERE id = ?").run(occurrenceId);

const activatedEngagement = (db: Database.Database, publicationEndAt: string) => {
  const p1 = readyPartner(db);
  const occurrenceId = seedOccurrence(db, p1.cityId);
  const terms = { reward_type: "PERCENT" as const, reward_value: 1000, customer_discount_type: "PERCENT" as const, customer_discount_value: 1000, publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: publicationEndAt, terms: {} };
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occurrenceId, terms, "offer");
  const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
  activateEngagement(db, admin, engagementId, revisionId);
  return { engagementId, occurrenceId, promo: p1.promo };
};

const finalized = (evidenceRef = "fixture-1"): (() => RewardRegistryFinalizationEvidence) => () => ({ finalized: true, evidence_ref: evidenceRef });
const notFinalized: () => RewardRegistryFinalizationEvidence = () => ({ finalized: false, evidence_ref: "n/a" });

describe("engagement closure (§B-7): forward-authority-only, one-time, dependency-seamed on reward-registry finalization", () => {
  it("refuses to close an engagement that is still OFFERED or ACCEPTED", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const { engagement_id: engagementId } = offerEngagement(db, admin, p1.partnerIdentityId, occurrenceId, { reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "NONE", customer_discount_value: 0, publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2020-02-01T00:00:00.000Z", terms: {} }, "offer");
    expect(() => closeEngagement(db, admin, engagementId, "closing", finalized())).toThrow(/AGENT_REFERRALS_ENGAGEMENT_ILLEGAL_TRANSITION/);
  });

  it("refuses to close while the occurrence is still SCHEDULED", () => {
    const db = fresh();
    const { engagementId } = activatedEngagement(db, new Date(Date.now() + 500).toISOString());
    expect(() => closeEngagement(db, admin, engagementId, "closing", finalized())).toThrow(/AGENT_REFERRALS_CLOSURE_OCCURRENCE_NOT_TERMINAL/);
  });

  // "Sales CLOSED" is checked directly (AGENT_REFERRALS_CLOSURE_SALES_NOT_CLOSED)
  // as its own §B-7 prerequisite, matching the plan's own separate bullet - but
  // this repository's pre-existing legacy trigger
  // (0011_occurrence_cancellation_and_refund_capabilities.sql) already refuses
  // any UPDATE that would leave an occurrence terminal with sales still OPEN,
  // so that combination cannot be constructed even via a raw UPDATE to prove
  // this check unreachable in isolation - it is real defense in depth, not
  // dead code.

  it("refuses to close while the publication window has not yet ended, and never invokes the reward-registry resolver for any of these local refusals", async () => {
    const db = fresh();
    const { engagementId, occurrenceId } = activatedEngagement(db, new Date(Date.now() + 60_000).toISOString());
    completeOccurrence(db, occurrenceId);
    const resolver = vi.fn(notFinalized);
    expect(() => closeEngagement(db, admin, engagementId, "closing", resolver)).toThrow(/AGENT_REFERRALS_CLOSURE_PUBLICATION_WINDOW_NOT_ENDED/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("fails closed with AGENT_REFERRALS_CLOSURE_REWARD_REGISTRY_FINALIZATION_UNAVAILABLE when every OTHER prerequisite holds but the resolver reports not-finalized - the dependency seam PR6 will satisfy", async () => {
    const db = fresh();
    const { engagementId, occurrenceId } = activatedEngagement(db, new Date(Date.now() + 500).toISOString());
    completeOccurrence(db, occurrenceId);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(() => closeEngagement(db, admin, engagementId, "closing", notFinalized)).toThrow(EngagementClosureError);
    expect(() => closeEngagement(db, admin, engagementId, "closing", notFinalized)).toThrow(/AGENT_REFERRALS_CLOSURE_REWARD_REGISTRY_FINALIZATION_UNAVAILABLE/);
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" }); // no partial close
  });

  it("closes successfully once every prerequisite holds, revokes only this occurrence's promo authorization, and leaves the partner's permanent promo globally ACTIVE", async () => {
    const db = fresh();
    const { engagementId, occurrenceId, promo } = activatedEngagement(db, new Date(Date.now() + 500).toISOString());
    completeOccurrence(db, occurrenceId);
    await new Promise((resolve) => setTimeout(resolve, 700));

    const result = closeEngagement(db, admin, engagementId, "closing", finalized("evidence-xyz"));
    expect(result.replayed).toBe(false);
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "CLOSED" });
    const closure = db.prepare("SELECT * FROM engagement_closure_events WHERE id = ?").get(result.closure_event_id) as Record<string, unknown>;
    expect(closure).toMatchObject({ engagement_id: engagementId, reward_registry_finalization_evidence_ref: "evidence-xyz" });
    const authorization = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(closure.revoked_promo_authorization_id as string) as { revoked_at: string | null };
    expect(authorization.revoked_at).not.toBeNull();
    const promoRow = db.prepare("SELECT status FROM promo_codes WHERE id = ?").get(promo.promo_code_id) as { status: string };
    expect(promoRow.status).toBe("ACTIVE"); // the permanent promo is never disabled globally by closing one occurrence
  });

  it("closure replay is idempotent, returns the same evidence, and never re-invokes the resolver", async () => {
    const db = fresh();
    const { engagementId, occurrenceId } = activatedEngagement(db, new Date(Date.now() + 500).toISOString());
    completeOccurrence(db, occurrenceId);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const first = closeEngagement(db, admin, engagementId, "closing", finalized());
    const resolver = vi.fn(() => { throw new Error("resolver must not be called on replay"); });
    const replay = closeEngagement(db, admin, engagementId, "closing again", resolver as unknown as () => RewardRegistryFinalizationEvidence);
    expect(replay).toEqual({ closure_event_id: first.closure_event_id, replayed: true });
    expect(resolver).not.toHaveBeenCalled();
  });

  describe("fault injection: no partial closure evidence under failure", () => {
    it("a fault at the closure-event insert rolls back the CLOSED transition and the promo-authorization revoke together", async () => {
      const db = fresh();
      const { engagementId, occurrenceId } = activatedEngagement(db, new Date(Date.now() + 500).toISOString());
      completeOccurrence(db, occurrenceId);
      await new Promise((resolve) => setTimeout(resolve, 700));

      db.exec(`CREATE TRIGGER poison_closure_event BEFORE INSERT ON engagement_closure_events
        BEGIN SELECT RAISE(ABORT, 'INJECTED_CLOSURE_FAILURE'); END;`);
      expect(() => closeEngagement(db, admin, engagementId, "closing", finalized())).toThrow(/INJECTED_CLOSURE_FAILURE/);
      db.exec("DROP TRIGGER poison_closure_event");

      expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" }); // rolled back, not left SUSPENDED/CLOSED with no evidence
      const authorization = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE engagement_id = ?").get(engagementId) as { revoked_at: string | null };
      expect(authorization.revoked_at).toBeNull();

      const retry = closeEngagement(db, admin, engagementId, "closing", finalized());
      expect(retry.replayed).toBe(false);
      expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "CLOSED" });
    });
  });
});
