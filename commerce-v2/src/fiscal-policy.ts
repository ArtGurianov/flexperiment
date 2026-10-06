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

/**
 * Qualification needs its legal basis: the offer and refund terms (ART-231) and the counsel's framing
 * (ART-234), each named, with the sha256 of the evidence the owner reviewed. Any QUALIFIED policy of
 * the same offer is retired in the same transaction, so there is never a moment with two or none.
 */
export function qualifyFiscalPolicy(
  db: Database.Database,
  command: { policyId: string; actor: string; legalBasis: { offerTermsRef: string; counselRef: string; evidenceSha256: string } },
  now = new Date().toISOString(),
) {
  const basis = command.legalBasis;
  if (!command.actor?.trim() || !basis?.offerTermsRef?.trim() || !basis?.counselRef?.trim()
    || !/^[a-f0-9]{64}$/.test(basis.evidenceSha256 ?? "")) throw new Error("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
  const apply = db.transaction(() => {
    const policy = db.prepare("SELECT offer_ref,status FROM fiscal_policy_versions WHERE id=?").get(command.policyId) as
      { offer_ref: string; status: string } | undefined;
    if (!policy) throw new Error("FISCAL_POLICY_NOT_FOUND");
    if (policy.status !== "DRAFT") throw new Error("FISCAL_POLICY_TRANSITION_INVALID");
    db.prepare("UPDATE fiscal_policy_versions SET status='RETIRED',retired_at=? WHERE offer_ref=? AND status='QUALIFIED'")
      .run(now, policy.offer_ref);
    db.prepare(`UPDATE fiscal_policy_versions SET status='QUALIFIED',legal_basis_json=?,qualified_by=?,qualified_at=? WHERE id=?`)
      .run(JSON.stringify({ offerTermsRef: basis.offerTermsRef.trim(), counselRef: basis.counselRef.trim(), evidenceSha256: basis.evidenceSha256 }),
        command.actor, now, command.policyId);
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
    FROM fiscal_policy_versions WHERE offer_ref=? AND product_kind=? AND status='QUALIFIED'`).get(offerRef, kind) as PolicyRow | undefined;
  if (!row) throw new Error("FISCAL_POLICY_NOT_QUALIFIED");
  return {
    policyId: row.id, version: row.version, itemName: row.item_name,
    taxSystem: row.tax_system, vatCode: row.vat_code, paymentMethod: row.payment_method, paymentObject: row.payment_object,
  };
}
