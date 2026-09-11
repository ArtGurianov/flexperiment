import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { normalizeAndValidateLegalProfile, type RawLegalRequisitesInput } from "../src/agent-referrals-legal-profile";
import {
  INN_LENGTH, KPP_LENGTH, LEGAL_FORMS, PROJECTED_CONTRACTOR_TYPES, REGISTRATION_NUMBER_LENGTH,
  REQUISITE_FIELDS, TAX_MODES, requisiteRule, resolveProjectedContractorType,
  type LegalForm, type RequisiteField, type TaxMode,
} from "../../lib/legal-profile-rules";

/**
 * PR-B: the database is a deliberate SECOND representation of the
 * legal-profile shape - migrations must not become runtime-dependent on
 * TypeScript, so `lib/legal-profile-rules.ts` cannot simply be imported by
 * `0043`/`0052`. What keeps the two honest is this test: it walks every cell
 * of the shared tables and proves the DB accepts EXACTLY what the domain
 * accepts, so changing one side without the other fails loudly here instead
 * of drifting until some caller meets a raw SqliteError in production.
 *
 * Each case exercises a REAL insert against a fully migrated database, never
 * a re-reading of the CHECK text.
 */

const fresh = () => {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
};

const seedAgent = (db: Database.Database) => {
  const agentId = `agent-${randomUUID()}`;
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`)
    .run(agentId, agentId, `${agentId}@example.test`);
  return agentId;
};

const digits = (length: number) => "1".repeat(length);

/** A tuple the DOMAIN considers valid for this legal_form - the baseline every case below mutates exactly one field of. */
const validRequisites = (legalForm: LegalForm): RawLegalRequisitesInput => ({
  full_name: "Ромашка",
  inn: digits(INN_LENGTH[legalForm]),
  opf: requisiteRule(legalForm, "opf") === "FORBIDDEN" ? null : "OOO",
  short_name: requisiteRule(legalForm, "short_name") === "FORBIDDEN" ? null : "Ромашка",
  kpp: requisiteRule(legalForm, "kpp") === "FORBIDDEN" ? null : digits(KPP_LENGTH),
  registration_number: requisiteRule(legalForm, "registration_number") === "FORBIDDEN" ? null : digits(REGISTRATION_NUMBER_LENGTH[legalForm]!),
  legal_address: requisiteRule(legalForm, "legal_address") === "FORBIDDEN" ? null : "г. Москва",
});

/** True when the DOMAIN validator accepts the tuple; it throws a typed 422 otherwise. */
const domainAccepts = (legalForm: LegalForm, taxMode: TaxMode, raw: RawLegalRequisitesInput): boolean => {
  try { normalizeAndValidateLegalProfile(legalForm, taxMode, raw); return true; } catch { return false; }
};

/** True when the DATABASE accepts the same tuple as a real row. */
const databaseAccepts = (
  db: Database.Database, agentId: string, legalForm: string, taxMode: string,
  projected: string, raw: RawLegalRequisitesInput, revision: number,
): boolean => {
  try {
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
      (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, short_name, inn, kpp, registration_number, legal_address, reason, assertion_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'conformance', 'PARTNER_ASSERTED')`)
      .run(randomUUID(), agentId, revision, legalForm, taxMode, projected,
        raw.opf ?? null, raw.full_name, raw.short_name ?? null, raw.inn, raw.kpp ?? null,
        raw.registration_number ?? null, raw.legal_address ?? null);
    return true;
  } catch { return false; }
};

describe("legal-profile shape: the shared rules and the database agree, cell by cell", () => {
  it("legal_form x tax_mode: the DB admits exactly the pairs the projection table names, and only with that pair's own projection", () => {
    const db = fresh();
    let revision = 0;
    for (const legalForm of LEGAL_FORMS) {
      for (const taxMode of TAX_MODES) {
        const expected = resolveProjectedContractorType(legalForm, taxMode);
        const raw = validRequisites(legalForm);
        expect(domainAccepts(legalForm, taxMode, raw)).toBe(expected !== null);

        for (const projected of PROJECTED_CONTRACTOR_TYPES) {
          // A fresh agent per attempt: UNIQUE(agent_id, revision) and the
          // supersession chain are not what this case is testing.
          const agentId = seedAgent(db);
          const accepted = databaseAccepts(db, agentId, legalForm, taxMode, projected, raw, ++revision);
          expect(
            accepted,
            `${legalForm}+${taxMode} as ${projected}: domain says ${expected ?? "REJECTED"}, database says ${accepted ? "accepted" : "rejected"}`,
          ).toBe(projected === expected);
        }
      }
    }
  });

  it("requisite presence: REQUIRED/FORBIDDEN/OPTIONAL mean the same thing to the validator and to the CHECKs", () => {
    const db = fresh();
    let revision = 0;
    for (const legalForm of LEGAL_FORMS) {
      const taxMode = TAX_MODES.find((mode) => resolveProjectedContractorType(legalForm, mode) !== null)!;
      const projected = resolveProjectedContractorType(legalForm, taxMode)!;

      for (const field of REQUISITE_FIELDS) {
        const rule = requisiteRule(legalForm, field);

        const omitted: RawLegalRequisitesInput = { ...validRequisites(legalForm), [field]: null };
        const omittedOk = rule !== "REQUIRED";
        expect(domainAccepts(legalForm, taxMode, omitted), `${legalForm}.${field} omitted (domain)`).toBe(omittedOk);
        expect(databaseAccepts(db, seedAgent(db), legalForm, taxMode, projected, omitted, ++revision), `${legalForm}.${field} omitted (database)`).toBe(omittedOk);

        const filler: Record<RequisiteField, string> = {
          opf: "OOO", short_name: "Ромашка", kpp: digits(KPP_LENGTH),
          registration_number: digits(REGISTRATION_NUMBER_LENGTH[legalForm] ?? 13), legal_address: "г. Москва",
        };
        const present: RawLegalRequisitesInput = { ...validRequisites(legalForm), [field]: filler[field] };
        const presentOk = rule !== "FORBIDDEN";
        expect(domainAccepts(legalForm, taxMode, present), `${legalForm}.${field} present (domain)`).toBe(presentOk);
        expect(databaseAccepts(db, seedAgent(db), legalForm, taxMode, projected, present, ++revision), `${legalForm}.${field} present (database)`).toBe(presentOk);
      }
    }
  });

  it("identifier lengths: ИНН/КПП/ОГРН(ИП) are the same digit counts on both sides", () => {
    const db = fresh();
    let revision = 0;
    for (const legalForm of LEGAL_FORMS) {
      const taxMode = TAX_MODES.find((mode) => resolveProjectedContractorType(legalForm, mode) !== null)!;
      const projected = resolveProjectedContractorType(legalForm, taxMode)!;
      const baseline = validRequisites(legalForm);

      const cases: Array<{ label: string; raw: RawLegalRequisitesInput }> = [
        { label: "inn one digit short", raw: { ...baseline, inn: digits(INN_LENGTH[legalForm] - 1) } },
        { label: "inn one digit long", raw: { ...baseline, inn: digits(INN_LENGTH[legalForm] + 1) } },
        { label: "inn non-numeric", raw: { ...baseline, inn: `${digits(INN_LENGTH[legalForm] - 1)}x` } },
      ];
      if (baseline.kpp !== null) {
        cases.push({ label: "kpp wrong length", raw: { ...baseline, kpp: digits(KPP_LENGTH + 1) } });
        cases.push({ label: "kpp non-numeric", raw: { ...baseline, kpp: `${digits(KPP_LENGTH - 1)}x` } });
      }
      if (baseline.registration_number !== null) {
        const length = REGISTRATION_NUMBER_LENGTH[legalForm]!;
        cases.push({ label: "registration_number wrong length", raw: { ...baseline, registration_number: digits(length + 1) } });
        cases.push({ label: "registration_number non-numeric", raw: { ...baseline, registration_number: `${digits(length - 1)}x` } });
      }

      for (const { label, raw } of cases) {
        expect(domainAccepts(legalForm, taxMode, raw), `${legalForm}: ${label} (domain)`).toBe(false);
        expect(databaseAccepts(db, seedAgent(db), legalForm, taxMode, projected, raw, ++revision), `${legalForm}: ${label} (database)`).toBe(false);
      }

      // The baseline itself must still be accepted by both, or the cases
      // above would be proving nothing.
      expect(domainAccepts(legalForm, taxMode, baseline)).toBe(true);
      expect(databaseAccepts(db, seedAgent(db), legalForm, taxMode, projected, baseline, ++revision)).toBe(true);
    }
  });
});
