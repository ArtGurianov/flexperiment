import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";

/**
 * 0053 (PR-F): tax/VAT treatment authority (agent_referrals_tax_treatment_
 * revisions, new table) + ORD canonicalization snapshot plumbing on
 * reward_settlements and ord_paid_invoice_payloads (new columns + extended
 * triggers, both by ALTER TABLE ADD COLUMN / DROP+CREATE TRIGGER - no
 * table rebuild). Deliberately NOT a fourth FK-off migration: neither new
 * settlement/payload column is NOT NULL at the column level (both tables
 * already mix LEGACY and AGENT_REFERRALS rows under one schema), so a plain
 * ALTER TABLE ADD COLUMN is sufficient.
 *
 * A production read-only check (2026-09-11) proved zero AGENT_REFERRALS
 * rows in reward_settlements and zero rows in ord_paid_invoice_payloads at
 * the time this migration was written - referenced in the migration's own
 * header as design evidence, not itself re-proven structurally here (unlike
 * 0052's zero-legacy-rows guard) because neither ALTER is NOT NULL and so
 * neither depends on that premise to be safe.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0053_agent_referrals_tax_treatment_ord_canonicalization.sql";
const BEFORE_0053 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0053").sort();
const M0053_BYTES = readFileSync(join(MIGRATIONS, MIGRATION_FILE));
const M0053_SHA256 = createHash("sha256").update(M0053_BYTES).digest("hex");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "tax-treatment-ord-canon-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0053) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0052 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "tax-treatment-ord-canon-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return db;
};

const seedAgent = (db: Database.Database, agentId = `agent-${randomUUID()}`) => {
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`)
    .run(agentId, agentId, `${agentId}@example.test`);
  return agentId;
};

const seedPartnerIdentity = (db: Database.Database, agentId: string, legalProfileRevisionId: string | null = null, partnerId = randomUUID()) => {
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'h', ?, 'admin')`)
    .run(partnerId, agentId, legalProfileRevisionId);
  return partnerId;
};

const seedLegalProfileRevision = (db: Database.Database, agentId: string, revisionId: string, taxMode: "NPD" | "OTHER", revision = 1) => {
  const legalForm = taxMode === "NPD" ? "INDIVIDUAL" : "INDIVIDUAL_ENTREPRENEUR";
  const projected = taxMode === "NPD" ? "SELF_EMPLOYED" : "INDIVIDUAL_ENTREPRENEUR";
  const registrationNumber = legalForm === "INDIVIDUAL_ENTREPRENEUR" ? "123456789012345" : null;
  db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, reason, assertion_source)
    VALUES (?, ?, ?, ?, ?, ?, 'Ivanov Ivan Ivanovich', '123456789012', ?, 'seed', 'PARTNER_ASSERTED')`)
    .run(revisionId, agentId, revision, legalForm, taxMode, projected, registrationNumber);
  return revisionId;
};

describe("0053 agent-referrals tax-treatment + ORD canonicalization migration", () => {
  it("is the exact committed file the registry pins as ordinary (not FK-off)", () => {
    expect(isFkOffMigration(MIGRATION_FILE, M0053_SHA256)).toBe(false);
  });

  it("applies cleanly on top of 0001-0052, FK stays ON throughout, foreign_key_check is clean", () => {
    const db = at0052();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
  });

  it("replays as an exact no-op", () => {
    const db = at0052();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("the FK_OFF_MIGRATIONS registry stays exactly the same three entries - 0053 is not among them", () => {
    expect(FK_OFF_MIGRATIONS).toHaveLength(3);
    expect(FK_OFF_MIGRATIONS.map((e) => e.filename)).toEqual([
      "0042_agent_referrals_agents_rebuild.sql",
      "0050_agent_referrals_legal_profile_provenance_rebuild.sql",
      "0052_agent_referrals_unified_legal_requisites.sql",
    ]);
  });

  describe("A. tax_system x vat_treatment x no_vat_basis matrix CHECK", () => {
    const seedProfile = (db: Database.Database, taxMode: "NPD" | "OTHER") => {
      const agentId = seedAgent(db);
      const lpId = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, taxMode);
      const partnerId = seedPartnerIdentity(db, agentId, lpId);
      return { partnerId, lpId };
    };

    it("accepts NPD/NO_VAT/NPD as SYSTEM_DERIVED", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "NPD");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-1', ?, ?, 1, 'NPD', 'NO_VAT', 'NPD', '2026-01-01T00:00:00.000Z', 'SYSTEM_DERIVED', 'auto')`).run(partnerId, lpId)).not.toThrow();
    });

    it("rejects NPD tax_system under ADMIN_ASSERTED, even with evidence", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "NPD");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-bad', ?, ?, 1, 'NPD', 'NO_VAT', 'NPD', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects SYSTEM_DERIVED for any non-NPD tax_system", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-bad2', ?, ?, 1, 'AUSN', 'NO_VAT', 'AUSN', '2026-01-01T00:00:00.000Z', 'SYSTEM_DERIVED', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });

    it("accepts AUSN/NO_VAT/AUSN as ADMIN_ASSERTED", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-ausn', ?, ?, 1, 'AUSN', 'NO_VAT', 'AUSN', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'ausn')`).run(partnerId, lpId)).not.toThrow();
    });

    it.each(["VAT_5", "VAT_7", "VAT_22"])("accepts USN/%s with no_vat_basis NULL", (vat) => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-usn', ?, ?, 1, 'USN', ?, NULL, '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'usn')`).run(partnerId, lpId, vat)).not.toThrow();
    });

    it("accepts USN/NO_VAT/USN_EXEMPT", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-usn-ex', ?, ?, 1, 'USN', 'NO_VAT', 'USN_EXEMPT', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'usn exempt')`).run(partnerId, lpId)).not.toThrow();
    });

    it("rejects USN/NO_VAT/OTHER_CONFIRMED (wrong basis for USN)", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-usn-bad', ?, ?, 1, 'USN', 'NO_VAT', 'OTHER_CONFIRMED', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });

    it.each(["OSNO", "ESHN", "OTHER"])("accepts %s/VAT_22", (taxSystem) => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-full', ?, ?, 1, ?, 'VAT_22', NULL, '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'full rate')`).run(partnerId, lpId, taxSystem)).not.toThrow();
    });

    it.each(["OSNO", "ESHN", "OTHER"])("accepts %s/NO_VAT/OTHER_CONFIRMED (confirmed exemption)", (taxSystem) => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-exempt', ?, ?, 1, ?, 'NO_VAT', 'OTHER_CONFIRMED', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'confirmed exemption')`).run(partnerId, lpId, taxSystem)).not.toThrow();
    });

    it("accepts PSN/NO_VAT/PSN for an individual entrepreneur (seedProfile('OTHER') is always IE)", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-psn', ?, ?, 1, 'PSN', 'NO_VAT', 'PSN', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'psn')`).run(partnerId, lpId)).not.toThrow();
    });

    it("rejects PSN/VAT_22 - PSN is always NO_VAT, never groupable with OSNO/ESHN/OTHER", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-psn-bad', ?, ?, 1, 'PSN', 'VAT_22', NULL, '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects PSN/NO_VAT/OTHER_CONFIRMED - PSN's own no_vat_basis is always PSN, never OTHER_CONFIRMED", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-psn-bad2', ?, ?, 1, 'PSN', 'NO_VAT', 'OTHER_CONFIRMED', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });

    it.each(["OSNO", "PSN", "ESHN", "OTHER"])("rejects %s/VAT_5 (not an allowed rate outside USN)", (taxSystem) => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-bad-rate', ?, ?, 1, ?, 'VAT_5', NULL, '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId, taxSystem))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects NO_VAT with a NULL no_vat_basis", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-no-basis', ?, ?, 1, 'USN', 'NO_VAT', NULL, '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects a real rate (VAT_5) with a non-NULL no_vat_basis", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-basis-forbidden', ?, ?, 1, 'USN', 'VAT_5', 'USN_EXEMPT', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects ADMIN_ASSERTED with a blank evidence_ref (whitespace-only)", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = seedProfile(db, "OTHER");
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-blank', ?, ?, 1, 'USN', 'NO_VAT', 'USN_EXEMPT', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', '   ', 'admin', 'x')`).run(partnerId, lpId))
        .toThrow(/CHECK constraint failed/);
    });
  });

  describe("B. relational consistency trigger", () => {
    it("rejects a treatment whose partner_identity and legal_profile_revision belong to DIFFERENT agents", () => {
      const db = at0052(); migrate(db);
      const agentA = seedAgent(db);
      const agentB = seedAgent(db);
      const lpA = seedLegalProfileRevision(db, agentA, `lp-${randomUUID()}`, "NPD");
      const partnerB = seedPartnerIdentity(db, agentB, null);
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-cross', ?, ?, 1, 'NPD', 'NO_VAT', 'NPD', '2026-01-01T00:00:00.000Z', 'SYSTEM_DERIVED', 'x')`).run(partnerB, lpA))
        .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT/);
    });

    it("rejects tax_system=NPD naming a legal profile whose OWN tax_mode is not NPD", () => {
      const db = at0052(); migrate(db);
      const agentId = seedAgent(db);
      const lpOther = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "OTHER");
      const partnerId = seedPartnerIdentity(db, agentId, lpOther);
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-mismatch', ?, ?, 1, 'NPD', 'NO_VAT', 'NPD', '2026-01-01T00:00:00.000Z', 'SYSTEM_DERIVED', 'x')`).run(partnerId, lpOther))
        .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT/);
    });

    it("rejects a non-NPD tax_system naming an NPD legal profile", () => {
      const db = at0052(); migrate(db);
      const agentId = seedAgent(db);
      const lpNpd = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "NPD");
      const partnerId = seedPartnerIdentity(db, agentId, lpNpd);
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-npd-mismatch', ?, ?, 1, 'USN', 'NO_VAT', 'USN_EXEMPT', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpNpd))
        .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT/);
    });

    it("rejects PSN naming a legal profile whose legal_form is NOT INDIVIDUAL_ENTREPRENEUR (P1.4)", () => {
      const db = at0052(); migrate(db);
      const agentId = seedAgent(db);
      const lpNpd = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "NPD");
      const partnerId = seedPartnerIdentity(db, agentId, lpNpd);
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-psn-legal-form', ?, ?, 1, 'PSN', 'NO_VAT', 'PSN', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpNpd))
        .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT/);
    });

    it("accepts PSN naming a legal profile whose legal_form IS INDIVIDUAL_ENTREPRENEUR", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = (() => {
        const agentId = seedAgent(db);
        const lpId = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "OTHER");
        const partnerId = seedPartnerIdentity(db, agentId, lpId);
        return { partnerId, lpId };
      })();
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-psn-legal-form-ok', ?, ?, 1, 'PSN', 'NO_VAT', 'PSN', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId)).not.toThrow();
    });
  });

  describe("F. effective_from canonical format CHECK (P1.1)", () => {
    const insertWith = (db: Database.Database, partnerId: string, lpId: string, effectiveFrom: string) =>
      db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-fmt', ?, ?, 1, 'NPD', 'NO_VAT', 'NPD', ?, 'SYSTEM_DERIVED', 'x')`).run(partnerId, lpId, effectiveFrom);

    it("accepts canonical millisecond-precision UTC ISO", () => {
      const db = at0052(); migrate(db);
      const { partnerId, lpId } = (() => {
        const agentId = seedAgent(db);
        const lpId = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "NPD");
        const partnerId = seedPartnerIdentity(db, agentId, lpId);
        return { partnerId, lpId };
      })();
      expect(() => insertWith(db, partnerId, lpId, "2026-01-01T00:00:00.000Z")).not.toThrow();
    });

    it.each(["2026-01-01", "2026-2-01", "zzz", "2026/07/01", "2026-07-01+03:00", "2026-01-01T00:00:00Z"])(
      "rejects malformed/non-canonical value %s",
      (raw) => {
        const db = at0052(); migrate(db);
        const agentId = seedAgent(db);
        const lpId = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "NPD");
        const partnerId = seedPartnerIdentity(db, agentId, lpId);
        expect(() => insertWith(db, partnerId, lpId, raw)).toThrow(/CHECK constraint failed/);
      },
    );
  });

  describe("G. SYSTEM_DERIVED uniqueness per legal_profile_revision_id (P2.1)", () => {
    it("rejects a second SYSTEM_DERIVED row naming the same legal_profile_revision_id", () => {
      const db = at0052(); migrate(db);
      const agentId = seedAgent(db);
      const lpId = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "NPD");
      const partnerId = seedPartnerIdentity(db, agentId, lpId);
      db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-sd-1', ?, ?, 1, 'NPD', 'NO_VAT', 'NPD', '2026-01-01T00:00:00.000Z', 'SYSTEM_DERIVED', 'x')`).run(partnerId, lpId);
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-sd-2', ?, ?, 2, 'NPD', 'NO_VAT', 'NPD', '2026-01-01T00:00:00.000Z', 'SYSTEM_DERIVED', 'x')`).run(partnerId, lpId))
        .toThrow(/UNIQUE constraint failed/);
    });

    it("does not restrict multiple ADMIN_ASSERTED rows for the same legal_profile_revision_id", () => {
      const db = at0052(); migrate(db);
      const agentId = seedAgent(db);
      const lpId = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "OTHER");
      const partnerId = seedPartnerIdentity(db, agentId, lpId);
      db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-aa-1', ?, ?, 1, 'USN', 'NO_VAT', 'USN_EXEMPT', '2026-01-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev.pdf', 'admin', 'x')`).run(partnerId, lpId);
      expect(() => db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
        VALUES ('tt-aa-2', ?, ?, 2, 'USN', 'VAT_22', NULL, '2026-06-01T00:00:00.000Z', 'ADMIN_ASSERTED', 'ev2.pdf', 'admin', 'correction')`).run(partnerId, lpId)).not.toThrow();
    });
  });

  describe("H. clean-slate production-zero-premise guard (P1.3)", () => {
    it("applies cleanly when all three checked tables are empty", () => {
      const db = at0052();
      expect(() => migrate(db)).not.toThrow();
    });

    it("fails closed when agent_referrals_legal_profile_revisions is non-empty", () => {
      const db = at0052();
      const agentId = seedAgent(db);
      seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "NPD");
      expect(() => migrate(db)).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 0 });
    });
  });

  describe("C. immutability", () => {
    it("blocks UPDATE and DELETE", () => {
      const db = at0052(); migrate(db);
      const agentId = seedAgent(db);
      const lpId = seedLegalProfileRevision(db, agentId, `lp-${randomUUID()}`, "NPD");
      const partnerId = seedPartnerIdentity(db, agentId, lpId);
      db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions(id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
        VALUES ('tt-guard', ?, ?, 1, 'NPD', 'NO_VAT', 'NPD', '2026-01-01T00:00:00.000Z', 'SYSTEM_DERIVED', 'x')`).run(partnerId, lpId);
      expect(() => db.exec("UPDATE agent_referrals_tax_treatment_revisions SET reason = 'y' WHERE id = 'tt-guard'")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_REVISION_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM agent_referrals_tax_treatment_revisions WHERE id = 'tt-guard'")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_REVISION_IMMUTABLE/);
    });
  });

  describe("D. FK topology", () => {
    it("has the expected new FK edges, all pointing at their declared targets", () => {
      const db = at0052(); migrate(db);
      const ttFks = db.prepare("PRAGMA foreign_key_list(agent_referrals_tax_treatment_revisions)").all() as { table: string; from: string; to: string }[];
      expect(ttFks.find((f) => f.from === "partner_identity_id")).toMatchObject({ table: "partner_identities", to: "id" });
      expect(ttFks.find((f) => f.from === "legal_profile_revision_id")).toMatchObject({ table: "agent_referrals_legal_profile_revisions", to: "id" });

      const settlementFks = db.prepare("PRAGMA foreign_key_list(reward_settlements)").all() as { table: string; from: string; to: string }[];
      expect(settlementFks.find((f) => f.from === "tax_treatment_revision_id_snapshot")).toMatchObject({ table: "agent_referrals_tax_treatment_revisions", to: "id" });

      const payloadFks = db.prepare("PRAGMA foreign_key_list(ord_paid_invoice_payloads)").all() as { table: string; from: string; to: string }[];
      expect(payloadFks.find((f) => f.from === "tax_treatment_revision_id_snapshot")).toMatchObject({ table: "agent_referrals_tax_treatment_revisions", to: "id" });
    });
  });

  describe("E. required-schema-objects evidence", () => {
    it("passes on a DB migrated through 0053", async () => {
      const { assertAgentReferralsFoundationSchemaPresent } = await import("../src/agent-referrals-activation");
      const db = at0052(); migrate(db);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    });

    it("fails closed and names the object when the new table is dropped", async () => {
      const { assertAgentReferralsFoundationSchemaPresent } = await import("../src/agent-referrals-activation");
      const db = at0052(); migrate(db);
      db.exec("DROP TABLE agent_referrals_tax_treatment_revisions");
      try {
        assertAgentReferralsFoundationSchemaPresent(db);
        throw new Error("expected a throw");
      } catch (error) {
        expect((error as Error).message).toContain("agent_referrals_tax_treatment_revisions");
      }
    });
  });
});
