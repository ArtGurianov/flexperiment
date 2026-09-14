import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals, suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES, mintFrameworkAgreementRevision, mintDelegationTemplateRevision, currentFrameworkAgreementRevision, currentDelegationTemplateRevision } from "../src/agent-referrals-framework-delegation";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { requiredFrameworkIssuance } from "../src/agent-referrals-framework-issuance";
import { currentAgentReferralsLegalProfile } from "../src/agent-referrals-legal-profile";
import { applyVerifiedLegalProfileForPartnerIdentity } from "../src/agent-referrals-legal-profile-supersession";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-framework-acceptance-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const framework = (overrides: Record<string, string> = {}) =>
  Object.fromEntries(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES.map((k) => [k, overrides[k] ?? `${k} v1`])) as Record<(typeof FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES)[number], string>;
const delegation = (overrides: Record<string, string> = {}) =>
  Object.fromEntries(DELEGATION_TEMPLATE_REQUIRED_CLAUSES.map((k) => [k, overrides[k] ?? `${k} v1`])) as Record<(typeof DELEGATION_TEMPLATE_REQUIRED_CLAUSES)[number], string>;

/**
 * Sets up a partner at FRAMEWORK_ISSUED with a real session, ready to
 * accept. `activate: false` lets a SECOND partner be readied against a db
 * that already has agent referrals ACTIVE (activateAgentReferrals is not
 * idempotent - a second call would fail its own optimistic-concurrency
 * check) - see the P0.4-style test below, which needs two real partners in
 * the same db.
 */
const readyToAccept = (db: Database.Database, activate = true) => {
  if (activate) activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, email, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', ?, 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, "INDIVIDUAL", "NPD", { full_name: "Ivanov Ivan Ivanovich", inn: "123456789012" }, 0);
  verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verified");

  // Framework/delegation content revisions are shared, db-wide, monotone
  // chains (like the legal-profile revisions above) - a second partner in
  // the same db mints the NEXT revision, never a fresh null-baseline one.
  const fw = mintFrameworkAgreementRevision(db, framework({ PARTNER_LEVY_OBLIGATION: `v-${randomUUID()}` }), currentFrameworkAgreementRevision(db)?.id ?? null);
  const dt = mintDelegationTemplateRevision(db, delegation(), currentDelegationTemplateRevision(db)?.id ?? null);
  issueFrameworkToPartner(db, admin, partnerIdentityId, fw.id, dt.id, "issued");

  const sessionId = randomUUID();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };

  return { partner, agentId, partnerIdentityId, fw, dt };
};

/** PR2 of the reissuance/evidence program: the pair a caller composes the step-up resource against is now (issuance_id, legal_profile_revision_id), never the old (framework_agreement_revision_id, delegation_template_revision_id) pair - see acceptFrameworkAndDelegation's own doc comment. */
const requiredAcceptanceParams = (db: Database.Database, partnerIdentityId: string, agentId: string) => ({
  issuanceId: requiredFrameworkIssuance(db, partnerIdentityId)!.id,
  legalProfileRevisionId: currentAgentReferralsLegalProfile(db, agentId)!.id,
});

const grantFor = (db: Database.Database, partner: PartnerPrincipal, issuanceId: string, legalProfileRevisionId: string) =>
  mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", { issuance_id: issuanceId, legal_profile_revision_id: legalProfileRevisionId }).grant_id;

describe("framework acceptance + effective ORD delegation: one atomic idempotent command", () => {
  it("creates framework_acceptances, ord_reporting_delegations, audit evidence, an outbox confirmation record, and the onboarding transition together", () => {
    const db = fresh();
    const { partner, agentId, partnerIdentityId } = readyToAccept(db);
    const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
    const grant = grantFor(db, partner, issuanceId, legalProfileRevisionId);

    const result = acceptFrameworkAndDelegation(db, partner, grant, issuanceId, legalProfileRevisionId);
    expect(result.replayed).toBe(false);
    expect(db.prepare("SELECT * FROM framework_acceptances WHERE id = ?").get(result.framework_acceptance_id)).toMatchObject({
      partner_identity_id: partner.partner_identity_id, issuance_id: issuanceId, legal_profile_revision_id: legalProfileRevisionId,
    });
    expect(db.prepare("SELECT ord_reporting_mode FROM ord_reporting_delegations WHERE id = ?").get(result.ord_reporting_delegation_id)).toEqual({ ord_reporting_mode: "FLEXPERIMENT_DELEGATED" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE event_kind = 'FRAMEWORK_ACCEPTED' AND partner_identity_id = ?").get(partner.partner_identity_id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION'").get()).toEqual({ n: 1 });
    expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ACCEPTED");
  });

  it("requires a partner principal + a fresh, correctly-bound step-up grant", () => {
    const db = fresh();
    const { agentId, partnerIdentityId, partner } = readyToAccept(db);
    const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
    expect(() => acceptFrameworkAndDelegation(db, partner, "nonexistent-grant", issuanceId, legalProfileRevisionId)).toThrow(/AGENT_REFERRALS_STEP_UP_GRANT_INVALID/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
  });

  it("admin cannot create accepted partner evidence: the function's signature admits only PartnerPrincipal, and there is no AdminPrincipal-shaped grant to consume", () => {
    const db = fresh();
    const { agentId, partnerIdentityId, partner } = readyToAccept(db);
    const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
    // An "admin principal" object structurally cannot supply a valid
    // partner_session_id bound to a real step_up_grants row - any grant
    // minted was minted FOR the partner's own session.
    const impostor = { realm: "ADMIN" as const, admin_id: "admin-1" } as unknown as PartnerPrincipal;
    const grant = grantFor(db, partner, issuanceId, legalProfileRevisionId);
    expect(() => acceptFrameworkAndDelegation(db, impostor, grant, issuanceId, legalProfileRevisionId)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
  });

  describe("idempotent exact replay", () => {
    it("the same partner, same exact required issuance and legal-profile revision, already accepted -> no duplicate anything", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const grant1 = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      const first = acceptFrameworkAndDelegation(db, partner, grant1, issuanceId, legalProfileRevisionId);

      const grant2 = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      const second = acceptFrameworkAndDelegation(db, partner, grant2, issuanceId, legalProfileRevisionId);

      expect(second).toEqual({ ...first, replayed: true });
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION'").get()).toEqual({ n: 1 });
      // The second grant was never even consumed - the replay short-circuits before touching it.
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant2)).toEqual({ consumed_at: null });
    });

    it("A accepted -> B accepted -> replay A returns A's exact historical evidence, never B", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const a = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const acceptedA = acceptFrameworkAndDelegation(db, partner, grantFor(db, partner, a.issuanceId, a.legalProfileRevisionId), a.issuanceId, a.legalProfileRevisionId);

      const fwB = mintFrameworkAgreementRevision(db, framework({ PARTNER_LEVY_OBLIGATION: "B" }), currentFrameworkAgreementRevision(db)!.id);
      const dtB = mintDelegationTemplateRevision(db, delegation(), currentDelegationTemplateRevision(db)!.id);
      issueFrameworkToPartner(db, admin, partnerIdentityId, fwB.id, dtB.id, "B");
      const b = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const acceptedB = acceptFrameworkAndDelegation(db, partner, grantFor(db, partner, b.issuanceId, b.legalProfileRevisionId), b.issuanceId, b.legalProfileRevisionId);

      const replayA = acceptFrameworkAndDelegation(db, partner, grantFor(db, partner, a.issuanceId, a.legalProfileRevisionId), a.issuanceId, a.legalProfileRevisionId);
      expect(replayA).toEqual({ ...acceptedA, replayed: true });
      expect(replayA.framework_acceptance_id).not.toBe(acceptedB.framework_acceptance_id);
    });

    it("a historical replay with a different caller legal-profile revision is refused, never replayed", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const a = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      acceptFrameworkAndDelegation(db, partner, grantFor(db, partner, a.issuanceId, a.legalProfileRevisionId), a.issuanceId, a.legalProfileRevisionId);

      applyVerifiedLegalProfileForPartnerIdentity(db, {
        partnerIdentityId, legalForm: "INDIVIDUAL", taxMode: "NPD", assertionSource: "ADMIN_ASSERTED", evidenceRef: "profile-8",
        reason: "name correction", full_name: "Ivanov Ivan Petrovich", inn: "123456789012",
      });
      const fwB = mintFrameworkAgreementRevision(db, framework({ PARTNER_LEVY_OBLIGATION: "B" }), currentFrameworkAgreementRevision(db)!.id);
      const dtB = mintDelegationTemplateRevision(db, delegation(), currentDelegationTemplateRevision(db)!.id);
      issueFrameworkToPartner(db, admin, partnerIdentityId, fwB.id, dtB.id, "B");
      const b = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      acceptFrameworkAndDelegation(db, partner, grantFor(db, partner, b.issuanceId, b.legalProfileRevisionId), b.issuanceId, b.legalProfileRevisionId);

      const mismatchedReplayGrant = grantFor(db, partner, a.issuanceId, b.legalProfileRevisionId);
      expect(() => acceptFrameworkAndDelegation(db, partner, mismatchedReplayGrant, a.issuanceId, b.legalProfileRevisionId))
        .toThrow(/AGENT_REFERRALS_REPLAY_LEGAL_PROFILE_MISMATCH/);
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(mismatchedReplayGrant)).toEqual({ consumed_at: null });
    });

    it("accepting an issuance that is not the one CURRENTLY required for this partner is refused outright, even a real issuance row that is otherwise valid (P0.4: admin issued to partner A, partner A cannot substitute partner B's real issuance)", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);

      // A second, unrelated partner gets a REAL issuance row of its own -
      // "otherwise valid content", just never issued to partner A. Partner
      // A never accepts its OWN required issuance first - the idempotent-
      // replay short-circuit is keyed by (partner, partner's own required
      // issuance), so an existing acceptance for A would mask this check
      // entirely (it never even inspects the caller's claimed issuanceId).
      const other = readyToAccept(db, false);
      const { issuanceId: otherIssuanceId } = requiredAcceptanceParams(db, other.partnerIdentityId, other.agentId);

      const grant2 = grantFor(db, partner, otherIssuanceId, legalProfileRevisionId);
      expect(() => acceptFrameworkAndDelegation(db, partner, grant2, otherIssuanceId, legalProfileRevisionId)).toThrow(/AGENT_REFERRALS_AGREEMENT_ISSUANCE_SUPERSEDED/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 }); // neither partner has accepted anything
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant2)).toEqual({ consumed_at: null });
    });

    it("an unaccepted stale issuance is refused after a later reissuance to the SAME partner", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const first = requiredAcceptanceParams(db, partnerIdentityId, agentId);

      const fw2 = mintFrameworkAgreementRevision(db, framework({ PARTNER_LEVY_OBLIGATION: "revised" }), currentFrameworkAgreementRevision(db)!.id);
      const dt = mintDelegationTemplateRevision(db, delegation(), currentDelegationTemplateRevision(db)!.id);
      issueFrameworkToPartner(db, admin, partnerIdentityId, fw2.id, dt.id, "reissued");
      const nowRequired = requiredFrameworkIssuance(db, partnerIdentityId)!;
      expect(nowRequired.id).not.toBe(first.issuanceId);

      // Partner tries to accept the now-STALE first issuance instead of the current one.
      const grant2 = grantFor(db, partner, first.issuanceId, first.legalProfileRevisionId);
      expect(() => acceptFrameworkAndDelegation(db, partner, grant2, first.issuanceId, first.legalProfileRevisionId)).toThrow(/AGENT_REFERRALS_AGREEMENT_ISSUANCE_SUPERSEDED/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant2)).toEqual({ consumed_at: null });
    });
  });

  describe("state prerequisites", () => {
    it("refuses when nothing has ever been issued to this partner (no framework_issuances row at all)", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
      const agentId = randomUUID();
      db.prepare(`INSERT INTO agents(id, slug, display_name, email, default_reward_type, default_reward_value)
        VALUES (?, ?, 'Agent', ?, 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
      const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      const sessionId = randomUUID();
      db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
      const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };
      // Neither an issuance nor a legal-profile revision exists yet for
      // this partner - requiredFrameworkIssuance() returns null before
      // either placeholder value below is ever consulted.
      const grant = grantFor(db, partner, "none", "none");
      expect(() => acceptFrameworkAndDelegation(db, partner, grant, "none", "none")).toThrow(/AGENT_REFERRALS_FRAMEWORK_NOT_ISSUED/);
    });
  });

  describe("global SUSPENDED blocks framework acceptance (plan section B-8: framework acceptance is NEW_AUTHORITY)", () => {
    it("succeeds under ACTIVE", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const grant = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      expect(() => acceptFrameworkAndDelegation(db, partner, grant, issuanceId, legalProfileRevisionId)).not.toThrow();
    });

    it("refuses under SUSPENDED, with zero partial effect and the grant left unconsumed", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const grant = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency suspend" });

      expect(() => acceptFrameworkAndDelegation(db, partner, grant, issuanceId, legalProfileRevisionId)).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);

      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant)).toEqual({ consumed_at: null });
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE event_kind = 'FRAMEWORK_ACCEPTED'").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION'").get()).toEqual({ n: 0 });
      expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ISSUED");
    });

    it("an idempotent replay of an already-accepted pair still succeeds under SUSPENDED - re-confirming existing evidence is not new authority", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const grant1 = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      const first = acceptFrameworkAndDelegation(db, partner, grant1, issuanceId, legalProfileRevisionId);

      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency suspend" });

      const grant2 = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      const replay = acceptFrameworkAndDelegation(db, partner, grant2, issuanceId, legalProfileRevisionId);
      expect(replay).toEqual({ ...first, replayed: true });
    });
  });

  describe("fault injection: no partial evidence under any failure", () => {
    it("fail audit insert -> no acceptance, no delegation, no onboarding transition, no outbox record", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const grant = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      db.exec(`CREATE TRIGGER poison_framework_audit BEFORE INSERT ON partner_identity_events
        WHEN NEW.event_kind = 'FRAMEWORK_ACCEPTED' BEGIN SELECT RAISE(ABORT, 'INJECTED_AUDIT_FAILURE'); END;`);

      expect(() => acceptFrameworkAndDelegation(db, partner, grant, issuanceId, legalProfileRevisionId)).toThrow(/INJECTED_AUDIT_FAILURE/);
      db.exec("DROP TRIGGER poison_framework_audit");

      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION'").get()).toEqual({ n: 0 });
      expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ISSUED");
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant)).toEqual({ consumed_at: null });
    });

    it("fail delegation insert -> no acceptance either (whole transaction rolls back)", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const grant = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      db.exec(`CREATE TRIGGER poison_delegation_insert BEFORE INSERT ON ord_reporting_delegations
        BEGIN SELECT RAISE(ABORT, 'INJECTED_DELEGATION_FAILURE'); END;`);

      expect(() => acceptFrameworkAndDelegation(db, partner, grant, issuanceId, legalProfileRevisionId)).toThrow(/INJECTED_DELEGATION_FAILURE/);
      db.exec("DROP TRIGGER poison_delegation_insert");

      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ISSUED");
    });

    it("fail outbox enqueue -> no acceptance, no delegation, no onboarding transition", () => {
      const db = fresh();
      const { agentId, partnerIdentityId, partner } = readyToAccept(db);
      const { issuanceId, legalProfileRevisionId } = requiredAcceptanceParams(db, partnerIdentityId, agentId);
      const grant = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      db.exec(`CREATE TRIGGER poison_confirmation_outbox BEFORE INSERT ON email_outbox
        WHEN NEW.type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION' BEGIN SELECT RAISE(ABORT, 'INJECTED_OUTBOX_FAILURE'); END;`);

      expect(() => acceptFrameworkAndDelegation(db, partner, grant, issuanceId, legalProfileRevisionId)).toThrow(/INJECTED_OUTBOX_FAILURE/);
      db.exec("DROP TRIGGER poison_confirmation_outbox");

      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 0 });
      expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ISSUED");

      // Recovers cleanly with a fresh grant.
      const retryGrant = grantFor(db, partner, issuanceId, legalProfileRevisionId);
      expect(() => acceptFrameworkAndDelegation(db, partner, retryGrant, issuanceId, legalProfileRevisionId)).not.toThrow();
    });
  });
});
