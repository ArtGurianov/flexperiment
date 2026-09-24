import {
  CertificationCapabilityError, type CertificationCapability, type CertificationClaim, type TrustedCheckoutFacts,
  authorizationDefect, InMemoryCertificationCapabilityStore,
} from "./capability";
import { directionAtLeast, type CertificationRun, type CertificationRunStore } from "./run";

/**
 * Admitting a certification checkout is one transaction, and the interface has
 * to say so.
 *
 * An authority that answered "authorized" and left the caller to create the
 * order afterwards would permit the sequence that matters most: spend the
 * one-shot capability, crash, no order. The run could then never finish and
 * the fence could never be passed again, with nothing in the record explaining
 * why. So there is no `authorize()` to call on its own - the caller hands in
 * what to do with the admission, and the capability is spent only if that
 * succeeds.
 *
 * In P9 this is one `BEGIN IMMEDIATE`:
 *
 *   look up the permanent checkout idempotency record
 *     found  -> require it belongs to this run, return it, spend nothing
 *   load the run; require CHECKOUT_SUBMITTING and FINANCIAL_EFFECT_POSSIBLE
 *   derive runtime SHA, deployment session, quote amount, occurrence
 *   validate the capability against those and against the run
 *   guarded consume of the capability
 *   INSERT the order carrying certification_run_id
 *   INSERT the idempotency record
 *   COMMIT
 */
export type ExistingCertificationOrder = {
  readonly orderId: string;
  readonly statusId: string;
  /** Provenance: which run's certification this order belongs to. */
  readonly certificationRunId: string;
};

/** Handed to the creator once, after everything has been proved. */
export type CertificationAuthorization = {
  readonly capability: CertificationCapability;
  readonly run: CertificationRun;
  readonly facts: TrustedCheckoutFacts;
};

export type CertificationCheckoutInput = {
  readonly idempotencyKey: string;
  readonly claim: CertificationClaim;
  readonly facts: TrustedCheckoutFacts;
  readonly now: Date;
};

export type CertificationReplay = { readonly kind: "REPLAY"; readonly order: ExistingCertificationOrder };

export interface CertificationCheckoutAuthority {
  /**
   * Returns whatever `create` returned, or the order this key already made.
   * Idempotency is resolved first: a retried request - a dropped response, a
   * resumed step re-run - must return the order it already created and must
   * not burn the capability on a request that creates nothing.
   */
  createOrReplay<T>(input: CertificationCheckoutInput, create: (authorization: CertificationAuthorization) => T): T | CertificationReplay;
}

export const isReplay = (result: unknown): result is CertificationReplay =>
  typeof result === "object" && result !== null && (result as CertificationReplay).kind === "REPLAY";

export interface CertificationOrderLedger {
  find(idempotencyKey: string): ExistingCertificationOrder | undefined;
  record(idempotencyKey: string, order: ExistingCertificationOrder): void;
}

/**
 * Test-only. The rollback below is what P9 gets for free from the transaction;
 * modelling it here is what makes "spend and create, or neither" a property
 * the contract can be tested against rather than a comment.
 */
export class InMemoryCertificationCheckoutAuthority implements CertificationCheckoutAuthority {
  constructor(
    private readonly capabilities: InMemoryCertificationCapabilityStore,
    private readonly runs: CertificationRunStore,
    private readonly orders: CertificationOrderLedger,
  ) {}

  createOrReplay<T>(input: CertificationCheckoutInput, create: (authorization: CertificationAuthorization) => T): T | CertificationReplay {
    if (!input.idempotencyKey) throw new CertificationCapabilityError("CERTIFICATION_CHECKOUT_IDEMPOTENCY_KEY_REQUIRED");

    const existing = this.orders.find(input.idempotencyKey);
    if (existing) {
      // A key belonging to another run is not a replay; it is one run reaching
      // into another's order, and returning it would hand over someone else's
      // purchase.
      if (existing.certificationRunId !== input.claim.runId) throw new CertificationCapabilityError("CERTIFICATION_CHECKOUT_KEY_FOREIGN_RUN", existing.orderId);
      return { kind: "REPLAY", order: existing };
    }

    const run = this.runs.load(input.claim.runId);
    if (!run) throw new CertificationCapabilityError("CERTIFICATION_RUN_NOT_FOUND", input.claim.runId);
    if (run.phase !== "CHECKOUT_SUBMITTING") throw new CertificationCapabilityError("CERTIFICATION_RUN_NOT_CHECKING_OUT", run.phase);
    // The run must already have recorded that money may exist. A checkout
    // admitted before that record is a payment nobody wrote down first.
    if (!directionAtLeast(run.direction, "FINANCIAL_EFFECT_POSSIBLE")) throw new CertificationCapabilityError("CERTIFICATION_RUN_FINANCIAL_EFFECT_NOT_ARMED", run.direction);
    if (directionAtLeast(run.direction, "CLEANUP_STARTED")) throw new CertificationCapabilityError("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN", run.direction);

    const capability = this.capabilities.get(input.claim.capabilityId);
    const defect = authorizationDefect(capability, input.claim, input.facts, run, input.now);
    if (defect) throw new CertificationCapabilityError(defect);

    // Created while unspent - `checkout` re-proves the authorization and
    // refuses a spent capability - then spent. A failure before the spend has
    // spent nothing; the production authority does both in one transaction.
    const created = create({ capability: capability!, run, facts: input.facts });
    this.capabilities.spend(capability!.id, input.now);
    this.orders.record(input.idempotencyKey, {
      orderId: (created as { orderId?: string }).orderId ?? "",
      statusId: (created as { statusId?: string }).statusId ?? "",
      certificationRunId: run.runId,
    });
    return created;
  }
}

export class InMemoryCertificationOrderLedger implements CertificationOrderLedger {
  #orders = new Map<string, ExistingCertificationOrder>();
  find(idempotencyKey: string): ExistingCertificationOrder | undefined { return this.#orders.get(idempotencyKey); }
  record(idempotencyKey: string, order: ExistingCertificationOrder): void { this.#orders.set(idempotencyKey, order); }
  get size(): number { return this.#orders.size; }
}
