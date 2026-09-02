import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { consumeStepUpGrantInTransaction, mintStepUpGrant, StepUpError } from "../src/agent-referrals-step-up";
import type { PartnerPrincipal } from "../src/agent-referrals-partner-identity";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-step-up-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const seedPartnerWithSession = (db: Database.Database): PartnerPrincipal => {
  const agentId = randomUUID();
  const partnerIdentityId = randomUUID();
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'A', 'A Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'h', 'admin')`).run(partnerIdentityId, agentId);
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  return { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };
};

const consumeInOwnTransaction = (db: Database.Database, partner: PartnerPrincipal, grantId: string, action: "FRAMEWORK_ACCEPTANCE" | "PAYOUT_PROFILE_SUPERSESSION", resource: Record<string, unknown>) =>
  db.transaction(() => consumeStepUpGrantInTransaction(db, partner, grantId, action, resource)).immediate();

const RESOURCE = { framework_agreement_revision_id: "fwr-1", delegation_template_revision_id: "dtr-1" };

describe("step-up grant", () => {
  it("a correct grant succeeds once", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    expect(() => consumeInOwnTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE)).not.toThrow();
  });

  it("replay is refused", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    consumeInOwnTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    expect(() => consumeInOwnTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE)).toThrow(StepUpError);
  });

  it("an expired grant is refused", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    // The exact ISO 8601 format production actually writes, not SQLite's own datetime('now') shape.
    db.prepare("UPDATE step_up_grants SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), grant.grant_id);
    expect(() => consumeInOwnTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE)).toThrow(StepUpError);
  });

  it("wrong partner (a different identity's principal) is refused", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const other = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    expect(() => consumeInOwnTransaction(db, other, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE)).toThrow(StepUpError);
  });

  it("wrong action is refused - a grant minted for one action cannot authorize another", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    expect(() => consumeInOwnTransaction(db, partner, grant.grant_id, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: null })).toThrow(StepUpError);
  });

  it("wrong resource is refused - even the same action, different resource fields", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    expect(() => consumeInOwnTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", { ...RESOURCE, delegation_template_revision_id: "dtr-DIFFERENT" }))
      .toThrow(StepUpError);
  });

  it("wrong revision is refused (a revision field changing is a resource mismatch)", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    expect(() => consumeInOwnTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", { ...RESOURCE, framework_agreement_revision_id: "fwr-OTHER" }))
      .toThrow(StepUpError);
  });

  it("a grant issued under one partner session cannot be consumed under a different session for the same identity", () => {
    const db = fresh();
    const partner = seedPartnerWithSession(db);
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);
    const otherSessionId = randomUUID();
    db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`)
      .run(otherSessionId, partner.partner_identity_id, randomUUID());
    const sameIdentityDifferentSession: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partner.partner_identity_id, partner_session_id: otherSessionId };
    expect(() => consumeInOwnTransaction(db, sameIdentityDifferentSession, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE)).toThrow(StepUpError);
  });

  it("an admin credential cannot substitute for step-up: the function's own type signature admits only PartnerPrincipal", () => {
    // Structural: consumeStepUpGrantInTransaction's second parameter type is
    // PartnerPrincipal - there is no overload, cast path, or admin_id column
    // on step_up_grants that an AdminPrincipal could satisfy.
    const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-step-up.ts"), "utf8");
    expect(source).toMatch(/consumeStepUpGrantInTransaction[\s\S]*?partner: PartnerPrincipal/);
    expect(source).not.toContain("AdminPrincipal");
  });

  describe("atomicity with the protected mutation", () => {
    it("if the protected mutation fails after consumption, the whole transaction rolls back and the grant remains usable for a legitimate retry", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", RESOURCE);

      expect(() => db.transaction(() => {
        consumeStepUpGrantInTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE);
        throw new Error("protected mutation failed");
      }).immediate()).toThrow("protected mutation failed");

      const row = db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant.grant_id) as { consumed_at: string | null };
      expect(row.consumed_at).toBeNull();
      expect(() => consumeInOwnTransaction(db, partner, grant.grant_id, "FRAMEWORK_ACCEPTANCE", RESOURCE)).not.toThrow();
    });
  });
});
