import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CheckoutSnapshotConfig } from "./checkout-snapshot";

/**
 * Product-specific fiscal authority (ART-233, migration 0017). What a receipt says about a line comes
 * from the QUALIFIED policy of its offer, never from the rail's global configuration or the CMS: a
 * policy is versioned, immutable, qualified on its own legal basis, and frozen into the order line.
 */
export type FiscalPolicyKind = "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
type FiscalSemantics = Pick<CheckoutSnapshotConfig, "taxSystem" | "vatCode" | "paymentObject"> & {
  readonly paymentMethod: "FULL_PREPAYMENT" | "PREPAYMENT" | "ADVANCE" | "FULL_PAYMENT";
};

/** What a quote freezes and an order line keeps: the semantics, and which policy said so. */
export type FrozenFiscalPolicy = FiscalSemantics & {
  readonly policyId: string;
  readonly version: number;
  readonly itemName: string;
};

type PolicyRow = {
  id: string; version: number; item_name: string; tax_system: FiscalSemantics["taxSystem"]; vat_code: "NONE";
  payment_method: FiscalSemantics["paymentMethod"]; payment_object: "SERVICE";
};

const audit = (db: Database.Database, actor: string, action: string, policyId: string, evidence: unknown, now: string) =>
  db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), actor, action, "FISCAL_POLICY", policyId, JSON.stringify(evidence), now);

/** A new version for an offer, as a DRAFT. Its content is final the moment it is written. */
export function draftFiscalPolicy(
  db: Database.Database,
  command: FiscalSemantics & { offerRef: string; kind: FiscalPolicyKind; itemName: string; actor: string },
  now = new Date().toISOString(),
) {
  if (!command.offerRef?.trim() || !command.actor?.trim()) throw new Error("FISCAL_POLICY_COMMAND_INVALID");
  const id = randomUUID();
  const write = db.transaction(() => {
    const version = (db.prepare("SELECT coalesce(max(version),0)+1 AS v FROM fiscal_policy_versions WHERE offer_ref=?")
      .get(command.offerRef) as { v: number }).v;
    db.prepare(`INSERT INTO fiscal_policy_versions(id,offer_ref,product_kind,version,item_name,tax_system,vat_code,
      payment_method,payment_object,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, command.offerRef, command.kind, version, command.itemName, command.taxSystem, command.vatCode,
        command.paymentMethod, command.paymentObject, command.actor, now);
    audit(db, command.actor, "FISCAL_POLICY_DRAFTED", id, { offerRef: command.offerRef, version }, now);
    return version;
  });
  return { policyId: id, version: write.immediate() };
}

/** New qualifications require immutable owner-approved evidence (ART-234). Legacy counsel
 * evidence remains readable and immutable; it is not an alternative path for new approvals. */
export function qualifyFiscalPolicy(
  db: Database.Database,
  command: { policyId: string; actor: string; ownerLegalDecisionId: string },
  now = new Date().toISOString(),
) {
  if (!command.actor?.trim() || !command.ownerLegalDecisionId?.trim()) throw new Error("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
  const apply = db.transaction(() => {
    const policy = db.prepare("SELECT offer_ref,status FROM fiscal_policy_versions WHERE id=?").get(command.policyId) as
      { offer_ref: string; status: string } | undefined;
    if (!policy) throw new Error("FISCAL_POLICY_NOT_FOUND");
    if (policy.status !== "DRAFT") throw new Error("FISCAL_POLICY_TRANSITION_INVALID");
    const decision = db.prepare(`SELECT offer_terms_ref,evidence_sha256 FROM owner_legal_decisions
      WHERE id=? AND fiscal_policy_id=? AND decided_by=?`).get(command.ownerLegalDecisionId, command.policyId, command.actor) as
      { offer_terms_ref: string; evidence_sha256: string } | undefined;
    if (!decision) throw new Error("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
    const basis = { type: "OWNER_LEGAL_DECISION", ownerLegalDecisionId: command.ownerLegalDecisionId,
      offerTermsRef: decision.offer_terms_ref, evidenceSha256: decision.evidence_sha256 };
    db.prepare("UPDATE fiscal_policy_versions SET status='RETIRED',retired_at=? WHERE offer_ref=? AND status='QUALIFIED'")
      .run(now, policy.offer_ref);
    db.prepare(`UPDATE fiscal_policy_versions SET status='QUALIFIED',legal_basis_json=?,qualified_by=?,qualified_at=? WHERE id=?`)
      .run(JSON.stringify(basis), command.actor, now, command.policyId);
    audit(db, command.actor, "FISCAL_POLICY_QUALIFIED", command.policyId, basis, now);
  });
  apply.immediate();
}

export function retireFiscalPolicy(db: Database.Database, command: { policyId: string; actor: string }, now = new Date().toISOString()) {
  if (!command.actor?.trim()) throw new Error("FISCAL_POLICY_COMMAND_INVALID");
  const apply = db.transaction(() => {
    const changed = db.prepare("UPDATE fiscal_policy_versions SET status='RETIRED',retired_at=? WHERE id=? AND status IN ('DRAFT','QUALIFIED')")
      .run(now, command.policyId).changes;
    if (changed !== 1) throw new Error("FISCAL_POLICY_TRANSITION_INVALID");
    audit(db, command.actor, "FISCAL_POLICY_RETIRED", command.policyId, {}, now);
  });
  apply.immediate();
}

/**
 * The policy a checkout of this offer freezes: the QUALIFIED one, of the offer's own kind. None means
 * the offer cannot be sold, whatever its sale mode says.
 */
export function qualifiedFiscalPolicy(db: Database.Database, offerRef: string, kind: FiscalPolicyKind): FrozenFiscalPolicy {
  const row = db.prepare(`SELECT id,version,item_name,tax_system,vat_code,payment_method,payment_object
    FROM fiscal_policy_versions f WHERE offer_ref=? AND product_kind=? AND status='QUALIFIED'
      AND (json_extract(f.legal_basis_json,'$.type') IS NOT 'OWNER_LEGAL_DECISION' OR EXISTS (
        SELECT 1 FROM owner_legal_decisions d JOIN legal_releases l ON l.id=d.legal_release_id
          JOIN offers o ON o.offer_ref=d.offer_ref JOIN products p ON p.id=o.product_id
        WHERE d.id=json_extract(f.legal_basis_json,'$.ownerLegalDecisionId') AND d.fiscal_policy_id=f.id AND p.product_ref=d.product_ref AND p.kind=f.product_kind
          AND l.active=1 AND l.version=d.legal_release_version AND l.manifest_json=d.legal_manifest_json))`).get(offerRef, kind) as PolicyRow | undefined;
  if (!row) throw new Error("FISCAL_POLICY_NOT_QUALIFIED");
  return {
    policyId: row.id, version: row.version, itemName: row.item_name,
    taxSystem: row.tax_system, vatCode: row.vat_code, paymentMethod: row.payment_method, paymentObject: row.payment_object,
  };
}
