import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { legalDocumentIds } from "../src/legal-manifest";
import {
  AgentReferralsContentRevisionError,
  currentDelegationTemplateRevision,
  currentFrameworkAgreementRevision,
  DELEGATION_TEMPLATE_REQUIRED_CLAUSES,
  delegationTemplateRevisionById,
  FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES,
  frameworkAgreementRevisionById,
  mintDelegationTemplateRevision,
  mintFrameworkAgreementRevision,
} from "../src/agent-referrals-framework-delegation";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-framework-delegation-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const framework = (overrides: Partial<Record<(typeof FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES)[number], string>> = {}) =>
  Object.fromEntries(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES.map((key) => [key, overrides[key] ?? `${key} text v1`])) as
    Record<(typeof FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES)[number], string>;

const delegation = (overrides: Partial<Record<(typeof DELEGATION_TEMPLATE_REQUIRED_CLAUSES)[number], string>> = {}) =>
  Object.fromEntries(DELEGATION_TEMPLATE_REQUIRED_CLAUSES.map((key) => [key, overrides[key] ?? `${key} text v1`])) as
    Record<(typeof DELEGATION_TEMPLATE_REQUIRED_CLAUSES)[number], string>;

describe("framework-agreement / delegation-template immutable content revisions", () => {
  describe("immutability", () => {
    it("a filed framework-agreement revision cannot be UPDATEd", () => {
      const db = fresh();
      const revision = mintFrameworkAgreementRevision(db, framework());
      expect(() => db.exec(`UPDATE framework_agreement_revisions SET content_hash = 'tampered' WHERE id = '${revision.id}'`))
        .toThrow(/FRAMEWORK_AGREEMENT_REVISION_IMMUTABLE/);
    });

    it("a filed delegation-template revision cannot be UPDATEd", () => {
      const db = fresh();
      const revision = mintDelegationTemplateRevision(db, delegation());
      expect(() => db.exec(`UPDATE delegation_template_revisions SET content_hash = 'tampered' WHERE id = '${revision.id}'`))
        .toThrow(/DELEGATION_TEMPLATE_REVISION_IMMUTABLE/);
    });
  });

  describe("content hash: exact and deterministic", () => {
    it("two independent mints of byte-identical content produce the same hash", () => {
      const db = fresh();
      const a = mintFrameworkAgreementRevision(db, framework());
      // Independently recomputed by the test, not read back from the row -
      // proves the hash is a pure function of content, not an opaque stamp.
      const recomputed = createHash("sha256").update(JSON.stringify({ clauses: FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES.map((key) => [key, `${key} text v1`]) })).digest("hex");
      expect(a.content_hash).toBe(recomputed);
    });

    it("changing one clause's text changes the hash", () => {
      const db = fresh();
      const a = mintFrameworkAgreementRevision(db, framework());
      const b = mintFrameworkAgreementRevision(db, framework({ PARTNER_LEVY_OBLIGATION: "a materially different clause" }));
      expect(a.content_hash).not.toBe(b.content_hash);
    });

    it("refuses incomplete content and names the missing clause(s), minting nothing", () => {
      const db = fresh();
      const incomplete = framework();
      delete (incomplete as Record<string, string>).PARTNER_LEVY_OBLIGATION;
      expect(() => mintFrameworkAgreementRevision(db, incomplete)).toThrow(AgentReferralsContentRevisionError);
      try { mintFrameworkAgreementRevision(db, incomplete); } catch (error) {
        expect((error as AgentReferralsContentRevisionError).message).toContain("PARTNER_LEVY_OBLIGATION");
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_agreement_revisions").get()).toEqual({ n: 0 });
    });
  });

  describe("supersession is forward-only, old revision stays readable", () => {
    it("framework agreement: revision 2 supersedes revision 1, revision 1 unchanged and readable", () => {
      const db = fresh();
      const first = mintFrameworkAgreementRevision(db, framework());
      const second = mintFrameworkAgreementRevision(db, framework({ PARTNER_LEVY_OBLIGATION: "revised clause" }));
      expect(second.revision).toBe(2);
      expect(second.supersedes_revision_id).toBe(first.id);

      const firstReadBack = frameworkAgreementRevisionById(db, first.id);
      expect(firstReadBack).toMatchObject({ id: first.id, revision: 1, content_hash: first.content_hash });
      expect(currentFrameworkAgreementRevision(db)).toMatchObject({ id: second.id, revision: 2 });
    });

    it("delegation template: revision 2 supersedes revision 1, revision 1 unchanged and readable", () => {
      const db = fresh();
      const first = mintDelegationTemplateRevision(db, delegation());
      const second = mintDelegationTemplateRevision(db, delegation({ REPORTING_TAIL_SURVIVES_CLOSURE_AND_REVOCATION: "revised" }));
      expect(second.supersedes_revision_id).toBe(first.id);
      expect(delegationTemplateRevisionById(db, first.id)).toMatchObject({ id: first.id, revision: 1 });
      expect(currentDelegationTemplateRevision(db)).toMatchObject({ id: second.id, revision: 2 });
    });
  });

  describe("no interaction with the public checkout legal bundle", () => {
    it("mints no side effect on legal_releases and never touches legalDocumentIds", () => {
      const db = fresh();
      const before = db.prepare("SELECT COUNT(*) AS n FROM legal_releases").get();
      mintFrameworkAgreementRevision(db, framework());
      mintDelegationTemplateRevision(db, delegation());
      expect(db.prepare("SELECT COUNT(*) AS n FROM legal_releases").get()).toEqual(before);

      for (const clauseKey of [...FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, ...DELEGATION_TEMPLATE_REQUIRED_CLAUSES]) {
        expect((legalDocumentIds as readonly string[]).includes(clauseKey)).toBe(false);
      }
      expect(legalDocumentIds).toEqual(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"]);
    });
  });

  describe("delegation always FLEXPERIMENT_DELEGATED (B-14)", () => {
    it("every minted delegation-template revision pins ord_reporting_mode structurally", () => {
      const db = fresh();
      const revision = mintDelegationTemplateRevision(db, delegation());
      expect(db.prepare("SELECT ord_reporting_mode FROM delegation_template_revisions WHERE id = ?").get(revision.id))
        .toEqual({ ord_reporting_mode: "FLEXPERIMENT_DELEGATED" });
    });
  });
});
