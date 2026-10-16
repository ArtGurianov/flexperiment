import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { legalManifestHash } from "./legal-control";

const text = z.string().trim().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commandSchema = z.object({
  policyId: text, legalReleaseId: text, legalManifestSha256: sha256, actor: text, decidedBy: text, decidedAt: z.string().datetime({ offset: true }),
  offerTermsRef: text, offerTermsSha256: sha256, refundTermsRef: text, refundTermsSha256: sha256,
  norms: z.array(z.object({ reference: text, url: z.string().url().startsWith("https://") }).strict()).min(1),
  facts: text, reasoning: text, riskAssessment: text, approvalRef: text, evidenceSha256: sha256,
}).strict();
export type OwnerLegalDecisionCommand = z.input<typeof commandSchema>;

/** Record an ACTUAL owner approval, separately from qualification. The trusted operator must
 * verify the referenced evidence bytes and owner authority first. This function neither invents
 * an approval nor verifies an external signature. No customer input or automatic qualification. */
export function recordOwnerLegalDecision(db: Database.Database, input: OwnerLegalDecisionCommand, now = new Date().toISOString()) {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(Date.parse(now))) throw new Error("OWNER_LEGAL_DECISION_INVALID");
  const c = parsed.data;
  if (c.actor !== c.decidedBy || Date.parse(c.decidedAt) > Date.parse(now)) throw new Error("OWNER_LEGAL_DECISION_INVALID");
  const apply = db.transaction(() => {
    const binding = db.prepare(`SELECT f.offer_ref,p.product_ref,l.id AS legal_release_id,l.version AS legal_release_version,l.manifest_json
      FROM fiscal_policy_versions f JOIN offers o ON o.offer_ref=f.offer_ref JOIN products p ON p.id=o.product_id
      JOIN legal_releases l ON l.storefront=CASE WHEN p.kind='LAB' THEN 'LAB' ELSE 'COURSES' END AND l.active=1
      WHERE f.id=? AND l.id=? AND f.status='DRAFT' AND f.product_kind=p.kind`).get(c.policyId, c.legalReleaseId) as
      { offer_ref: string; product_ref: string; legal_release_id: string; legal_release_version: string; manifest_json: string } | undefined;
    if (!binding) throw new Error("FISCAL_POLICY_OFFER_MISMATCH");
    // When the approved release contains the transaction documents, bind their exact URLs/hashes.
    // Stage A legacy/test releases may have separately approved terms; Stage B always includes them.
    const manifest = JSON.parse(binding.manifest_json);
    if (legalManifestHash(manifest) !== c.legalManifestSha256) throw new Error("OWNER_LEGAL_DECISION_TERMS_MISMATCH");
    for (const [kind, ref, hash] of [["course_offer", c.offerTermsRef, c.offerTermsSha256], ["refund_terms", c.refundTermsRef, c.refundTermsSha256]]) {
      const doc = manifest.documents.find((d: { kind: string; url: string; sha256: string }) => d.kind === kind);
      if (doc && (doc.url !== ref || doc.sha256 !== hash)) throw new Error("OWNER_LEGAL_DECISION_TERMS_MISMATCH");
    }
    const version = (db.prepare("SELECT coalesce(max(version),0)+1 AS v FROM owner_legal_decisions WHERE offer_ref=?")
      .get(binding.offer_ref) as { v: number }).v;
    const id = randomUUID();
    db.prepare(`INSERT INTO owner_legal_decisions(id,version,fiscal_policy_id,product_ref,offer_ref,legal_release_id,legal_release_version,legal_manifest_json,
      offer_terms_ref,offer_terms_sha256,refund_terms_ref,refund_terms_sha256,norms_json,facts,reasoning,risk_assessment,
      approval_ref,evidence_sha256,decided_by,decided_at,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, version, c.policyId, binding.product_ref, binding.offer_ref, binding.legal_release_id, binding.legal_release_version, binding.manifest_json,
        c.offerTermsRef, c.offerTermsSha256, c.refundTermsRef, c.refundTermsSha256, JSON.stringify(c.norms), c.facts, c.reasoning,
        c.riskAssessment, c.approvalRef, c.evidenceSha256, c.decidedBy, c.decidedAt, c.actor, now);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), c.actor, "OWNER_LEGAL_DECISION_RECORDED", "OWNER_LEGAL_DECISION", id,
        JSON.stringify({ version, policyId: c.policyId, approvalRef: c.approvalRef, evidenceSha256: c.evidenceSha256 }), now);
    return { ownerLegalDecisionId: id, version };
  });
  return apply.immediate();
}

/** Free-text merchant legal evidence is retained, not assumed anonymous. A possible subject
 * mention needs explicit review before erasure/cleanup. Old reviewed backups predate this table. */
export function ownerLegalEvidenceMentions(db: Database.Database, subjects: readonly string[]) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_legal_decisions'").get()) return false;
  const evidence = db.prepare(`SELECT * FROM owner_legal_decisions`).all();
  return evidence.some(row => subjects.some(subject => subject.length > 0 && JSON.stringify(row).includes(subject)));
}
