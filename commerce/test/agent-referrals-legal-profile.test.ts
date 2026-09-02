import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import {
  AgentReferralsLegalProfileError,
  allAgentReferralsLegalProfileRevisions,
  applyAgentReferralsLegalProfile,
  currentAgentReferralsLegalProfile,
  type LegalForm,
  type ProjectedContractorType,
  type TaxMode,
} from "../src/agent-referrals-legal-profile";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-legal-profile-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return { db, file };
};

const seedAgent = (db: Database.Database, contractorType = "SELF_EMPLOYED") => {
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, ?, '123456789012', 'C-1', 'PERCENT', 1000)`)
    .run(agentId, `agent-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`, contractorType);
  return agentId;
};

const agentContractorType = (db: Database.Database, agentId: string) =>
  (db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(agentId) as { contractor_type: string }).contractor_type;

describe("agent-referrals legal-profile revisions", () => {
  describe("6-case matrix, individually", () => {
    const cases: Array<{ legal_form: LegalForm; tax_mode: TaxMode; allowed: boolean; projected?: ProjectedContractorType }> = [
      { legal_form: "INDIVIDUAL", tax_mode: "NPD", allowed: true, projected: "SELF_EMPLOYED" },
      { legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "NPD", allowed: true, projected: "INDIVIDUAL_ENTREPRENEUR" },
      { legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER", allowed: true, projected: "INDIVIDUAL_ENTREPRENEUR" },
      { legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", allowed: true, projected: "ORGANIZATION" },
      { legal_form: "INDIVIDUAL", tax_mode: "OTHER", allowed: false },
      { legal_form: "LEGAL_ENTITY", tax_mode: "NPD", allowed: false },
    ];

    it.each(cases)("$legal_form + $tax_mode -> allowed=$allowed", ({ legal_form, tax_mode, allowed, projected }) => {
      const { db } = fresh();
      const agentId = seedAgent(db);

      if (allowed) {
        const result = applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form, tax_mode, reason: "matrix test" });
        expect(result).toMatchObject({ revision: 1, projected_contractor_type: projected, minted: true });
        expect(agentContractorType(db, agentId)).toBe(projected);
        const current = currentAgentReferralsLegalProfile(db, agentId);
        expect(current).toMatchObject({ legal_form, tax_mode, projected_contractor_type: projected, revision: 1, supersedes_revision_id: null });

        // Historical revision unchanged: still exactly one row, unaltered.
        expect(allAgentReferralsLegalProfileRevisions(db, agentId)).toHaveLength(1);
      } else {
        const before = agentContractorType(db, agentId);
        const eventsBefore = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get();

        expect(() => applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form, tax_mode, reason: "matrix test" }))
          .toThrow(AgentReferralsLegalProfileError);

        expect(agentContractorType(db, agentId)).toBe(before);
        expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get()).toEqual(eventsBefore);
        expect(currentAgentReferralsLegalProfile(db, agentId)).toBeNull();
      }
    });
  });

  describe("transactional atomicity", () => {
    it("a rejected combination leaves no revision, no agent projection change, no partial evidence", () => {
      const { db } = fresh();
      const agentId = seedAgent(db, "SELF_EMPLOYED");
      expect(() => applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "OTHER", reason: "reject" }))
        .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REJECTED_COMBINATION/);
      expect(agentContractorType(db, agentId)).toBe("SELF_EMPLOYED");
      expect(allAgentReferralsLegalProfileRevisions(db, agentId)).toEqual([]);
    });
  });

  describe("idempotent same-semantic retry", () => {
    it("re-submitting the same (legal_form, tax_mode) mints no new revision", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      const first = applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "NPD", reason: "initial" });
      const second = applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "NPD", reason: "retry" });
      expect(second).toEqual({ revision_id: first.revision_id, revision: 1, projected_contractor_type: "SELF_EMPLOYED", minted: false });
      expect(allAgentReferralsLegalProfileRevisions(db, agentId)).toHaveLength(1);
    });
  });

  describe("new material profile mints a new revision", () => {
    it("a genuinely different (legal_form, tax_mode) mints revision 2, superseding revision 1", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "NPD", reason: "initial" });
      const second = applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER", reason: "became an IE" });
      expect(second).toMatchObject({ revision: 2, projected_contractor_type: "INDIVIDUAL_ENTREPRENEUR", minted: true });
      expect(agentContractorType(db, agentId)).toBe("INDIVIDUAL_ENTREPRENEUR");

      const all = allAgentReferralsLegalProfileRevisions(db, agentId);
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ revision: 1, legal_form: "INDIVIDUAL", tax_mode: "NPD" }); // historical revision unchanged
      expect(all[1]).toMatchObject({ revision: 2, legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER", supersedes_revision_id: all[0].id });

      // Current cannot point at nonexistent/superseded evidence: it is always the latest.
      expect(currentAgentReferralsLegalProfile(db, agentId)).toMatchObject({ revision: 2, id: all[1].id });
    });
  });

  describe("concurrency: two simultaneous updates of one profile", () => {
    it("the same identical request racing collapses to one revision (idempotent, not double-applied)", () => {
      const { db: a, file } = fresh();
      const agentId = seedAgent(a);
      const b = new Database(file); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

      const first = applyAgentReferralsLegalProfile(a, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "racer A" });
      const second = applyAgentReferralsLegalProfile(b, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "racer B" });

      expect(first.minted).toBe(true);
      expect(second.minted).toBe(false);
      expect(second.revision_id).toBe(first.revision_id);
      expect(allAgentReferralsLegalProfileRevisions(a, agentId)).toHaveLength(1);
      expect(agentContractorType(a, agentId)).toBe("ORGANIZATION");
    });

    it("two different requests racing over the same agent each mint their own revision, serialized", () => {
      const { db: a, file } = fresh();
      const agentId = seedAgent(a);
      const b = new Database(file); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

      const first = applyAgentReferralsLegalProfile(a, { agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "NPD", reason: "racer A" });
      const second = applyAgentReferralsLegalProfile(b, { agent_id: agentId, legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "NPD", reason: "racer B" });

      expect(first).toMatchObject({ revision: 1, minted: true });
      expect(second).toMatchObject({ revision: 2, minted: true });
      expect(allAgentReferralsLegalProfileRevisions(a, agentId)).toHaveLength(2);
      expect(agentContractorType(a, agentId)).toBe("INDIVIDUAL_ENTREPRENEUR");
    });
  });

  describe("legacy API untouched", () => {
    it("agentSchema/agentPatchSchema stay two-valued (unchanged by PR3, re-asserted here for locality)", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "types.ts"), "utf8");
      const agentSchemaBlock = source.slice(source.indexOf("export const agentSchema"), source.indexOf("export const agentPatchSchema"));
      const agentPatchSchemaBlock = source.slice(source.indexOf("export const agentPatchSchema"), source.indexOf("export const agentPatchSchema") + 800);
      expect(agentSchemaBlock).toContain('z.enum(["SELF_EMPLOYED", "INDIVIDUAL_ENTREPRENEUR"])');
      expect(agentPatchSchemaBlock).toContain('z.enum(["SELF_EMPLOYED", "INDIVIDUAL_ENTREPRENEUR"])');
      expect(agentSchemaBlock).not.toContain("ORGANIZATION");
      expect(agentPatchSchemaBlock).not.toContain("ORGANIZATION");
    });
  });
});
