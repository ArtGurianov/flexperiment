import type Database from "better-sqlite3";
import { emergencySalesPaused } from "../emergency-sales-gate";
import { CertificationCapabilityError, type CertificationClaim } from "./capability";
import { isReplay, type CertificationCheckoutAuthority } from "./checkout-authority";
import type { CertificationContext } from "../domain/checkout";
import { SqliteCertificationCheckoutAuthority, SqliteCertificationOrderLedger } from "./checkout-authority-sqlite";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "./store-sqlite";
import { SqliteCatalogueMutationLedger } from "./catalogue-authority-sqlite";
import type { PresentedCertificationCapability } from "../release/sales-gate";

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
 * The claim on the wire: each of `capabilityId`, `runId` and `nonce`
 * base64url-encoded on its own, joined by `.`.
 *
 * The fields used to go raw, `<capabilityId>.<runId>.<nonce>`, split on `.`
 * into exactly three - and the nonce is `<keyVersion>.<hmac>`, so every real
 * claim arrived as four pieces and was refused as MALFORMED. Encoding each
 * field is what makes the separator unambiguous, whatever a field contains;
 * special-casing "four pieces" would only fit today's nonce.
 *
 * Built and read by these two functions and nothing else, so the runner that
 * sends a claim and the runtime that admits one cannot drift apart.
 */
const encodeField = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export const encodeCertificationClaim = (claim: CertificationClaim): string =>
  [claim.capabilityId, claim.runId, claim.nonce].map(encodeField).join(".");

/** Refused by shape before anything looks up a capability with it. */
export const parseCertificationClaim = (header: string | undefined | null): CertificationClaim | undefined => {
  const raw = (header ?? "").trim();
  if (!raw) return undefined;
  const parts = raw.split(".");
  if (parts.length !== 3) throw new CertificationCapabilityError("CERTIFICATION_CLAIM_MALFORMED");
  const fields = parts.map((part) => {
    const value = Buffer.from(part, "base64url").toString("utf8");
    // One spelling per claim: a part that does not re-encode to itself is
    // not base64url of anything, whatever Node's lenient decoder made of it.
    if (!part || encodeField(value) !== part || !FIELD.test(value)) throw new CertificationCapabilityError("CERTIFICATION_CLAIM_MALFORMED");
    return value;
  });
  const [capabilityId, runId, nonce] = fields;
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

/**
 * A certification's quote, behind the fence its own release closed.
 *
 * `checkoutContext` answers the sales gate like every public route, and while a
 * cutover holds the deployment fence that answer is closed - so a certification
 * could never obtain the quote its checkout needs. The fence is opened here the
 * way the checkout opens it: by presenting the capability to the one canonical
 * gate, which still answers the emergency and business gates first. Nothing is
 * bypassed around it.
 *
 * Narrower than a checkout, because a quote is only ever the run's own fixture
 * at the one step that asks for it:
 *
 *   - the run named by the claim is at OCCURRENCE_OPEN, going forward;
 *   - the occurrence is the one this run's catalogue ledger says it created -
 *     a runtime-owned record, not the run row the runner writes;
 *   - no promo or referral rides along: a certification buys the fixture at
 *     its price.
 *
 * Every fact handed to the gate is the server's own. The capability is
 * presented, never spent: spending belongs to the checkout, with its order.
 */
export const presentCertificationQuote = (
  db: Database.Database,
  claim: CertificationClaim,
  request: { readonly occurrenceId: string; readonly promoCode?: string; readonly referralSlug?: string },
): PresentedCertificationCapability => {
  if (request.promoCode || request.referralSlug) throw new CertificationCapabilityError("CERTIFICATION_QUOTE_ATTRIBUTION_FORBIDDEN");
  const run = new SqliteCertificationRunStore(db).load(claim.runId);
  if (!run) throw new CertificationCapabilityError("CERTIFICATION_RUN_NOT_FOUND", claim.runId);
  if (run.phase !== "OCCURRENCE_OPEN" || run.direction !== "NORMAL") {
    throw new CertificationCapabilityError("CERTIFICATION_RUN_NOT_QUOTING", `${run.phase}/${run.direction}`);
  }
  const fixture = new SqliteCatalogueMutationLedger(db, run.runId).occurrenceId();
  if (!fixture || fixture !== request.occurrenceId || run.occurrenceId !== fixture) {
    throw new CertificationCapabilityError("CERTIFICATION_QUOTE_NOT_THIS_RUN", request.occurrenceId);
  }
  const occurrence = db.prepare("SELECT price_kopecks FROM occurrences WHERE id = ?").get(fixture) as { price_kopecks: number } | undefined;
  if (!occurrence) throw new CertificationCapabilityError("CERTIFICATION_QUOTE_NOT_THIS_RUN", fixture);
  const fence = db.prepare("SELECT id FROM deploy_sessions WHERE deployment_gate_closed = 1").get() as { id: string } | undefined;
  const capability = new SqliteCertificationCapabilityStore(db).get(claim.capabilityId);
  if (!capability) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_NOT_FOUND");
  return {
    capability,
    claim,
    facts: {
      deploymentSessionId: fence?.id ?? "",
      runtimeReleaseSha: process.env.SOURCE_COMMIT?.trim() ?? "",
      actualAmountKopecks: Number(occurrence.price_kopecks),
      checkoutOccurrenceId: fixture,
    },
    expected: { runId: run.runId, releaseSha: run.releaseSha, occurrenceId: run.occurrenceId },
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
