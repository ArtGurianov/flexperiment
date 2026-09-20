import type Database from "better-sqlite3";
import { emergencySalesPaused } from "../emergency-sales-gate";
import { CertificationCapabilityError, type CertificationClaim } from "./capability";
import { isReplay, type CertificationCheckoutAuthority } from "./checkout-authority";
import type { CertificationContext } from "../domain/checkout";
import { SqliteCertificationCheckoutAuthority, SqliteCertificationOrderLedger } from "./checkout-authority-sqlite";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "./store-sqlite";

/**
 * Reading a certification claim off a request, and nothing else.
 *
 * It travels in a header rather than the query string: a query parameter lands
 * in access logs, proxy logs and browser history, and this one is the
 * difference between an open fence and a closed one. The body is not used
 * either - the body is hashed into the permanent idempotency record, and a
 * secret does not belong in a value the system keeps forever.
 */
export const CERTIFICATION_CLAIM_HEADER = "X-Certification-Claim";

const FIELD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * `<capabilityId>.<runId>.<nonce>`. Three opaque fields, so a malformed header
 * is refused by shape before anything looks up a capability with it.
 */
export const parseCertificationClaim = (header: string | undefined | null): CertificationClaim | undefined => {
  const raw = (header ?? "").trim();
  if (!raw) return undefined;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((part) => !FIELD.test(part))) {
    throw new CertificationCapabilityError("CERTIFICATION_CLAIM_MALFORMED");
  }
  const [capabilityId, runId, nonce] = parts;
  return { capabilityId, runId, nonce };
};

export type AdmissionFacts = {
  readonly deploymentSessionId: string;
  readonly runtimeReleaseSha: string;
  readonly actualAmountKopecks: number;
  readonly checkoutOccurrenceId: string;
};

/**
 * The server's own facts about what this checkout would buy.
 *
 * Read from the quote - which is written once and never updated - and from the
 * live fence. Nothing here comes from the request, because a caller who could
 * state the amount or the occurrence would be telling the gate what to compare
 * against.
 */
export const admissionFacts = (db: Database.Database, quoteId: string): AdmissionFacts => {
  const quote = db.prepare("SELECT occurrence_id, final_amount_kopecks FROM quotes WHERE id = ?")
    .get(quoteId) as { occurrence_id: string; final_amount_kopecks: number } | undefined;
  if (!quote) throw new CertificationCapabilityError("CERTIFICATION_CHECKOUT_QUOTE_NOT_FOUND");
  const fence = db.prepare("SELECT id FROM deploy_sessions WHERE deployment_gate_closed = 1").get() as { id: string } | undefined;
  return {
    // No fence means nothing to bypass. The empty string cannot match a session
    // id, so a capability presented outside a cutover is refused rather than
    // silently accepted against a gate that is already open.
    deploymentSessionId: fence?.id ?? "",
    runtimeReleaseSha: process.env.SOURCE_COMMIT?.trim() ?? "",
    actualAmountKopecks: Number(quote.final_amount_kopecks),
    checkoutOccurrenceId: String(quote.occurrence_id),
  };
};

export const productionCheckoutAuthority = (db: Database.Database): CertificationCheckoutAuthority =>
  new SqliteCertificationCheckoutAuthority(
    db,
    new SqliteCertificationCapabilityStore(db),
    new SqliteCertificationRunStore(db),
    new SqliteCertificationOrderLedger(db),
  );

export type AdmittedCheckout<T> = { readonly kind: "CREATED"; readonly result: T } | { readonly kind: "REPLAY"; readonly statusId: string };

/**
 * Admits one certification checkout: idempotency, run, capability and order,
 * all inside the authority's single transaction.
 *
 * The capability is spent and the order is created together or not at all, and
 * a repeat of the same request returns the order the key already made without
 * touching the capability a second time.
 */
export const admitCertificationCheckout = <T>(
  db: Database.Database,
  claim: CertificationClaim,
  quoteId: string,
  idempotencyKey: string,
  now: Date,
  create: (certification: CertificationContext) => T,
): AdmittedCheckout<T> => {
  const admit = db.transaction(() => {
    // Answered first and unconditionally, inside the same transaction as
    // everything else. A capability that could pass the operator's own stop
    // would turn the last manual switch in the system into an advisory one,
    // and putting the check in a route would leave it skippable by the next
    // caller of this function.
    if (emergencySalesPaused(db)) throw new CertificationCapabilityError("EMERGENCY_SALES_GATE_CLOSED");
    return admitInTransaction(db, claim, quoteId, idempotencyKey, now, create);
  });
  return db.inTransaction ? admit() : admit.immediate();
};

const admitInTransaction = <T>(
  db: Database.Database,
  claim: CertificationClaim,
  quoteId: string,
  idempotencyKey: string,
  now: Date,
  create: (certification: CertificationContext) => T,
): AdmittedCheckout<T> => {
  const facts = admissionFacts(db, quoteId);
  const authority = productionCheckoutAuthority(db);
  const outcome = authority.createOrReplay({ idempotencyKey, claim, facts, now }, (authorization) => create({
    capability: authorization.capability,
    claim,
    run: { runId: authorization.run.runId, releaseSha: authorization.run.releaseSha, occurrenceId: authorization.run.occurrenceId },
    runtimeReleaseSha: facts.runtimeReleaseSha,
    deploymentSessionId: facts.deploymentSessionId,
  }));
  return isReplay(outcome) ? { kind: "REPLAY", statusId: outcome.order.statusId } : { kind: "CREATED", result: outcome as T };
};
