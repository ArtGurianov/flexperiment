import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyV2Migration, migrateV2 } from "../src/db";
import { draftFiscalPolicy, qualifiedFiscalPolicy, qualifyFiscalPolicy, retireFiscalPolicy } from "../src/fiscal-policy";
import { activateLegalRelease, legalManifestHash } from "../src/legal-control";
import { recordOwnerLegalDecision, ownerLegalEvidenceMentions } from "../src/owner-legal-decision";
import { stageBLegalManifest } from "./fixtures/legal";

const now = "2026-10-16T10:00:00Z";
let db: Database.Database;
const draft = () => draftFiscalPolicy(db, { actor: "owner", offerRef: "course:one", kind: "ONLINE_COURSE", itemName: "Информационное видео",
  taxSystem: "USN_INCOME", vatCode: "NONE", paymentMethod: "FULL_PAYMENT", paymentObject: "SERVICE" }, now).policyId;
const catalogue = () => {
  activateLegalRelease(db, { storefront: "COURSES", version: "reviewed-v1", manifest: stageBLegalManifest, actor: "owner" }, now);
  db.exec(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:one','ONLINE_COURSE','PAID','one');
    INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('o','course:one','p',100,'CLOSED')`);
};
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); catalogue(); });
afterEach(() => db.close());
const command = (policyId: string) => ({ policyId, actor: "owner", decidedBy: "owner", decidedAt: now,
  legalReleaseId: (db.prepare("SELECT id FROM legal_releases WHERE active=1").get() as { id: string }).id,
  legalManifestSha256: legalManifestHash(stageBLegalManifest),
  offerTermsRef: "https://flexperiment.ru/legal/course_offer", offerTermsSha256: "a".repeat(64),
  refundTermsRef: "https://flexperiment.ru/legal/refund_terms", refundTermsSha256: "a".repeat(64),
  norms: [{ reference: "SYNTHETIC 54-FZ / ART-234", url: "https://example.test/law" }],
  facts: "Synthetic personal viewing facts", reasoning: "Synthetic fiscal timing reasoning", riskAssessment: "Synthetic risks and mitigations",
  approvalRef: "synthetic:actual-owner-choice", evidenceSha256: "e".repeat(64),
});
const qualify = (policyId: string, ownerLegalDecisionId: string, actor = "owner") =>
  qualifyFiscalPolicy(db, { policyId, ownerLegalDecisionId, actor }, now);

describe("OwnerLegalDecision authority without an external counsel dependency", () => {
  it("records immutable versioned evidence without qualifying or enabling a sale", () => {
    const policyId = draft();
    const first = recordOwnerLegalDecision(db, { ...command(policyId), actor: "trusted-import-operator" }, now);
    expect(db.prepare("SELECT decided_by,recorded_by FROM owner_legal_decisions WHERE id=?").get(first.ownerLegalDecisionId))
      .toEqual({ decided_by: "owner", recorded_by: "trusted-import-operator" });
    const second = recordOwnerLegalDecision(db, command(policyId), now);
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(() => qualifiedFiscalPolicy(db, "course:one", "ONLINE_COURSE")).toThrow("FISCAL_POLICY_NOT_QUALIFIED");
    expect(() => db.prepare("UPDATE owner_legal_decisions SET evidence_sha256=? WHERE id=?").run("f".repeat(64), first.ownerLegalDecisionId))
      .toThrow("OWNER_LEGAL_DECISION_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM owner_legal_decisions").run()).toThrow("OWNER_LEGAL_DECISION_APPEND_ONLY");
    qualify(policyId, second.ownerLegalDecisionId);
    expect(qualifiedFiscalPolicy(db, "course:one", "ONLINE_COURSE")).toMatchObject({ policyId, paymentMethod: "FULL_PAYMENT" });
    expect(db.prepare("SELECT sale_mode FROM offers").get()).toEqual({ sale_mode: "CLOSED" });
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='OWNER_LEGAL_DECISION_RECORDED'").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 0 });
  });
  it("refuses missing norms, invalid evidence, missing/future authority and mismatched approved terms", () => {
    const c = command(draft());
    for (const change of [{ norms: [] }, { norms: [{ reference: " ", url: "https://example.test" }] },
      { evidenceSha256: "bad" }, { approvalRef: " " }, { riskAssessment: " " }, { decidedBy: " " }, { decidedAt: "2027-01-01T00:00:00Z" }]) {
      expect(() => recordOwnerLegalDecision(db, { ...c, ...change }, now)).toThrow("OWNER_LEGAL_DECISION_INVALID");
    }
    for (const change of [{ offerTermsSha256: "b".repeat(64) }, { refundTermsRef: "https://example.test/wrong" }, { legalManifestSha256: "f".repeat(64) }]) {
      expect(() => recordOwnerLegalDecision(db, { ...c, ...change }, now)).toThrow("OWNER_LEGAL_DECISION_TERMS_MISMATCH");
    }
    expect(db.prepare("SELECT count(*) n FROM owner_legal_decisions").get()).toEqual({ n: 0 });
  });
  it("cannot reuse a decision for different fiscal content, policy, product or actor; retirement rolls back on refusal", () => {
    const policyId = draft(); const decision = recordOwnerLegalDecision(db, command(policyId), now);
    qualify(policyId, decision.ownerLegalDecisionId);
    const next = draft();
    expect(() => qualify(next, decision.ownerLegalDecisionId)).toThrow("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
    expect(qualifiedFiscalPolicy(db, "course:one", "ONLINE_COURSE").policyId).toBe(policyId);
    const secondDecision = recordOwnerLegalDecision(db, command(next), now);
    expect(() => qualify(next, secondDecision.ownerLegalDecisionId, "other")).toThrow("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
    expect(() => db.prepare("UPDATE fiscal_policy_versions SET payment_method='FULL_PREPAYMENT' WHERE id=?").run(next)).toThrow("FISCAL_POLICY_IMMUTABLE");
  });
  it("stops new qualification and checkout after legal release drift without changing old evidence", () => {
    const policyId = draft(); const decision = recordOwnerLegalDecision(db, command(policyId), now);
    qualify(policyId, decision.ownerLegalDecisionId);
    const second = draft(); const secondDecision = recordOwnerLegalDecision(db, command(second), now);
    const evidence = db.prepare("SELECT * FROM owner_legal_decisions ORDER BY version").all();
    activateLegalRelease(db, { storefront: "COURSES", version: "reviewed-v2", manifest: stageBLegalManifest, actor: "owner" }, now);
    expect(() => qualifiedFiscalPolicy(db, "course:one", "ONLINE_COURSE")).toThrow("FISCAL_POLICY_NOT_QUALIFIED");
    expect(() => qualify(second, secondDecision.ownerLegalDecisionId)).toThrow("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
    expect(db.prepare("SELECT * FROM owner_legal_decisions ORDER BY version").all()).toEqual(evidence);
    expect(db.prepare("SELECT status FROM fiscal_policy_versions WHERE id=?").get(policyId)).toEqual({ status: "QUALIFIED" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("checks direct SQL decisions/qualifications and preserves possible subject evidence for review", () => {
    const policyId = draft(); const decision = recordOwnerLegalDecision(db, { ...command(policyId), facts: "customer@example.test" }, now);
    expect(ownerLegalEvidenceMentions(db, ["customer@example.test"])).toBe(true);
    expect(ownerLegalEvidenceMentions(db, ["other@example.test"])).toBe(false);
    const row = db.prepare("SELECT * FROM owner_legal_decisions WHERE id=?").get(decision.ownerLegalDecisionId) as Record<string, unknown>;
    for (const patch of [{ fiscal_policy_id: draft() , product_ref: "other" }, { offer_terms_sha256: "b".repeat(64) }, { norms_json: '[{}]' }, { norms_json: '["fake"]' }]) {
      const next = { ...row, ...patch, id: "bad", version: 2 };
      expect(() => db.prepare(`INSERT INTO owner_legal_decisions(${Object.keys(next).join(",")}) VALUES (${Object.keys(next).map(() => "?").join(",")})`)
        .run(...Object.values(next))).toThrow("OWNER_LEGAL_DECISION_INVALID");
    }
    for (const basis of [{ counselRef: "legacy:counsel", offerTermsRef: "x", evidenceSha256: "e".repeat(64) },
      { type: "OWNER_LEGAL_DECISION", ownerLegalDecisionId: "missing" }]) {
      expect(() => db.prepare("UPDATE fiscal_policy_versions SET status='QUALIFIED',legal_basis_json=?,qualified_by='owner',qualified_at=? WHERE id=?")
        .run(JSON.stringify(basis), now, policyId)).toThrow("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
    }
  });
  it("upgrades a real legacy qualification without rewriting even one evidence byte", () => {
    db.close(); db = new Database(":memory:"); db.pragma("foreign_keys=ON");
    const dir = join(process.cwd(), "commerce-v2/migrations");
    const migrations = readdirSync(dir).filter(n => n.endsWith(".sql")).sort();
    for (const file of migrations.slice(0, 26)) applyV2Migration(db, file, readFileSync(join(dir, file), "utf8"));
    catalogue(); const policyId = draft();
    const raw = '{ "offerTermsRef":"old-offer", "counselRef":"genuine:legacy-opinion", "evidenceSha256":"' + "d".repeat(64) + '" }';
    db.prepare("UPDATE fiscal_policy_versions SET status='QUALIFIED',legal_basis_json=?,qualified_by='legacy-owner',qualified_at=? WHERE id=?").run(raw, now, policyId);
    db.exec("INSERT INTO customers(id,email_normalized) VALUES ('legacy-customer','legacy@example.test')");
    const legalId = (db.prepare("SELECT id FROM legal_releases WHERE active=1").get() as { id: string }).id;
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
      VALUES ('legacy-order','legacy-public','legacy-customer','FULFILLED',100,?, ?,?)`)
      .run('{"schema":"refref.shared-checkout-snapshot/1","legacyFrozenEvidence":true}', "a".repeat(64), legalId);
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,
      catalog_amount_kopecks,merchant_discount_kopecks,merchant_amount_kopecks,fiscal_item_json,legal_release_ref,legal_release_hash,fiscal_policy_id)
      VALUES ('legacy-line','legacy-order','p','course:one','Legacy',100,'old-offer',100,0,100,?, 'legacy-legal',?,?)`)
      .run('{"name":"Legacy","paymentMethod":"FULL_PAYMENT","paymentObject":"SERVICE"}', "a".repeat(64), policyId);
    const frozenOrder = db.prepare("SELECT * FROM orders").all();
    const frozenLine = db.prepare("SELECT * FROM order_lines").all();
    const before = db.prepare("SELECT * FROM fiscal_policy_versions").all();
    migrateV2(db);
    expect(db.prepare("SELECT * FROM fiscal_policy_versions").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM orders").all()).toEqual(frozenOrder);
    expect(db.prepare("SELECT * FROM order_lines").all()).toEqual(frozenLine.map(row => ({ ...(row as Record<string, unknown>), immediate_access_json: null })));
    expect(qualifiedFiscalPolicy(db, "course:one", "ONLINE_COURSE").policyId).toBe(policyId);
    expect(db.prepare("SELECT count(*) n FROM owner_legal_decisions").get()).toEqual({ n: 0 });
    retireFiscalPolicy(db, { policyId, actor: "owner" }, now);
    expect((db.prepare("SELECT legal_basis_json FROM fiscal_policy_versions WHERE id=?").get(policyId) as { legal_basis_json: string }).legal_basis_json).toBe(raw);
    expect(db.prepare("SELECT count(*) n FROM schema_migrations").get()).toEqual({ n: 36 });
    const hash = createHash("sha256").update(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all())).digest("hex");
    expect(hash).toBe("089392a156085ce6e353b0998cbd53a75c1d08ecda7f604787532c0f1b096221");
  });
});
