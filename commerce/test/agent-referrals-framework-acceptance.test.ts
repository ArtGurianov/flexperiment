import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES, mintFrameworkAgreementRevision, mintDelegationTemplateRevision } from "../src/agent-referrals-framework-delegation";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";

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

/** Sets up a partner at FRAMEWORK_ISSUED with a real session, ready to accept. */
const readyToAccept = (db: Database.Database) => {
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const { partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id, partner_session_id: "n/a" }, "INDIVIDUAL", "NPD");
  verifyPartnerLegalProfile(db, admin, partner_identity_id, "verified");
  issueFrameworkToPartner(db, admin, partner_identity_id, "issued");

  const sessionId = randomUUID();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partner_identity_id, randomUUID());
  const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id, partner_session_id: sessionId };

  const fw = mintFrameworkAgreementRevision(db, framework());
  const dt = mintDelegationTemplateRevision(db, delegation());
  return { partner, fw, dt };
};

const grantFor = (db: Database.Database, partner: PartnerPrincipal, fwId: string, dtId: string) =>
  mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", { framework_agreement_revision_id: fwId, delegation_template_revision_id: dtId }).grant_id;

describe("framework acceptance + effective ORD delegation: one atomic idempotent command", () => {
  it("creates framework_acceptances, ord_reporting_delegations, audit evidence, an outbox confirmation record, and the onboarding transition together", () => {
    const db = fresh();
    const { partner, fw, dt } = readyToAccept(db);
    const grant = grantFor(db, partner, fw.id, dt.id);

    const result = acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id);
    expect(result.replayed).toBe(false);
    expect(db.prepare("SELECT * FROM framework_acceptances WHERE id = ?").get(result.framework_acceptance_id)).toMatchObject({
      partner_identity_id: partner.partner_identity_id, framework_agreement_revision_id: fw.id, delegation_template_revision_id: dt.id,
    });
    expect(db.prepare("SELECT ord_reporting_mode FROM ord_reporting_delegations WHERE id = ?").get(result.ord_reporting_delegation_id)).toEqual({ ord_reporting_mode: "FLEXPERIMENT_DELEGATED" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE event_kind = 'FRAMEWORK_ACCEPTED' AND partner_identity_id = ?").get(partner.partner_identity_id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION'").get()).toEqual({ n: 1 });
    expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ACCEPTED");
  });

  it("requires a partner principal + a fresh, correctly-bound step-up grant", () => {
    const db = fresh();
    const { partner, fw, dt } = readyToAccept(db);
    expect(() => acceptFrameworkAndDelegation(db, partner, "nonexistent-grant", fw.id, dt.id)).toThrow(/AGENT_REFERRALS_STEP_UP_GRANT_INVALID/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
  });

  it("admin cannot create accepted partner evidence: the function's signature admits only PartnerPrincipal, and there is no AdminPrincipal-shaped grant to consume", () => {
    const db = fresh();
    const { partner, fw, dt } = readyToAccept(db);
    // An "admin principal" object structurally cannot supply a valid
    // partner_session_id bound to a real step_up_grants row - any grant
    // minted was minted FOR the partner's own session.
    const impostor = { realm: "ADMIN" as const, admin_id: "admin-1" } as unknown as PartnerPrincipal;
    const grant = grantFor(db, partner, fw.id, dt.id);
    expect(() => acceptFrameworkAndDelegation(db, impostor, grant, fw.id, dt.id)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
  });

  describe("idempotent exact replay", () => {
    it("the same partner, same exact framework revision, same exact delegation revision, already accepted -> no duplicate anything", () => {
      const db = fresh();
      const { partner, fw, dt } = readyToAccept(db);
      const grant1 = grantFor(db, partner, fw.id, dt.id);
      const first = acceptFrameworkAndDelegation(db, partner, grant1, fw.id, dt.id);

      const grant2 = grantFor(db, partner, fw.id, dt.id);
      const second = acceptFrameworkAndDelegation(db, partner, grant2, fw.id, dt.id);

      expect(second).toEqual({ ...first, replayed: true });
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION'").get()).toEqual({ n: 1 });
      // The second grant was never even consumed - the replay short-circuits before touching it.
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant2)).toEqual({ consumed_at: null });
    });

    it("a changed revision is NOT an idempotent replay - it is refused outright", () => {
      const db = fresh();
      const { partner, fw, dt } = readyToAccept(db);
      const grant1 = grantFor(db, partner, fw.id, dt.id);
      acceptFrameworkAndDelegation(db, partner, grant1, fw.id, dt.id);

      const fw2 = mintFrameworkAgreementRevision(db, framework({ PARTNER_LEVY_OBLIGATION: "revised" }));
      const grant2 = grantFor(db, partner, fw2.id, dt.id);
      expect(() => acceptFrameworkAndDelegation(db, partner, grant2, fw2.id, dt.id)).toThrow(/AGENT_REFERRALS_FRAMEWORK_ACCEPTANCE_REVISION_CHANGED/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 1 });
    });
  });

  describe("state prerequisites", () => {
    it("refuses when onboarding is not yet FRAMEWORK_ISSUED", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
      const agentId = randomUUID();
      db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
        VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
      const { partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      const sessionId = randomUUID();
      db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partner_identity_id, randomUUID());
      const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id, partner_session_id: sessionId };
      const fw = mintFrameworkAgreementRevision(db, framework());
      const dt = mintDelegationTemplateRevision(db, delegation());
      const grant = grantFor(db, partner, fw.id, dt.id);
      expect(() => acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id)).toThrow(/AGENT_REFERRALS_FRAMEWORK_NOT_ISSUED/);
    });
  });

  describe("fault injection: no partial evidence under any failure", () => {
    it("fail audit insert -> no acceptance, no delegation, no onboarding transition, no outbox record", () => {
      const db = fresh();
      const { partner, fw, dt } = readyToAccept(db);
      const grant = grantFor(db, partner, fw.id, dt.id);
      db.exec(`CREATE TRIGGER poison_framework_audit BEFORE INSERT ON partner_identity_events
        WHEN NEW.event_kind = 'FRAMEWORK_ACCEPTED' BEGIN SELECT RAISE(ABORT, 'INJECTED_AUDIT_FAILURE'); END;`);

      expect(() => acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id)).toThrow(/INJECTED_AUDIT_FAILURE/);
      db.exec("DROP TRIGGER poison_framework_audit");

      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION'").get()).toEqual({ n: 0 });
      expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ISSUED");
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant)).toEqual({ consumed_at: null });
    });

    it("fail delegation insert -> no acceptance either (whole transaction rolls back)", () => {
      const db = fresh();
      const { partner, fw, dt } = readyToAccept(db);
      const grant = grantFor(db, partner, fw.id, dt.id);
      db.exec(`CREATE TRIGGER poison_delegation_insert BEFORE INSERT ON ord_reporting_delegations
        BEGIN SELECT RAISE(ABORT, 'INJECTED_DELEGATION_FAILURE'); END;`);

      expect(() => acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id)).toThrow(/INJECTED_DELEGATION_FAILURE/);
      db.exec("DROP TRIGGER poison_delegation_insert");

      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ISSUED");
    });

    it("fail outbox enqueue -> no acceptance, no delegation, no onboarding transition", () => {
      const db = fresh();
      const { partner, fw, dt } = readyToAccept(db);
      const grant = grantFor(db, partner, fw.id, dt.id);
      db.exec(`CREATE TRIGGER poison_confirmation_outbox BEFORE INSERT ON email_outbox
        WHEN NEW.type = 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION' BEGIN SELECT RAISE(ABORT, 'INJECTED_OUTBOX_FAILURE'); END;`);

      expect(() => acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id)).toThrow(/INJECTED_OUTBOX_FAILURE/);
      db.exec("DROP TRIGGER poison_confirmation_outbox");

      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 0 });
      expect(getPartnerIdentity(db, partner.partner_identity_id)!.onboarding_state).toBe("FRAMEWORK_ISSUED");

      // Recovers cleanly with a fresh grant.
      const retryGrant = grantFor(db, partner, fw.id, dt.id);
      expect(() => acceptFrameworkAndDelegation(db, partner, retryGrant, fw.id, dt.id)).not.toThrow();
    });
  });
});
