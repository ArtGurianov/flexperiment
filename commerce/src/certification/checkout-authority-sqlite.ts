import type Database from "better-sqlite3";
import { sha256 } from "../crypto";
import { CertificationCapabilityError, authorizationDefect } from "./capability";
import {
  type CertificationAuthorization, type CertificationCheckoutAuthority, type CertificationCheckoutInput,
  type CertificationOrderLedger, type CertificationReplay, type ExistingCertificationOrder,
} from "./checkout-authority";
import { directionAtLeast, type CertificationRunStore } from "./run";
import type { SqliteCertificationCapabilityStore } from "./store-sqlite";

/**
 * The production checkout authority: the ordering the contract describes,
 * performed as one `BEGIN IMMEDIATE`.
 *
 * The in-memory reference restores a spent capability by hand when creation
 * throws. Here that is not modelled at all - the transaction rolls back, and
 * the capability was never spent. Which is the point of moving it here: "spend
 * and create, or neither" stops being a sequence someone has to get right and
 * becomes a property of the write.
 */
export class SqliteCertificationCheckoutAuthority implements CertificationCheckoutAuthority {
  constructor(
    private readonly db: Database.Database,
    private readonly capabilities: SqliteCertificationCapabilityStore,
    private readonly runs: CertificationRunStore,
    private readonly orders: CertificationOrderLedger,
  ) {}

  createOrReplay<T>(input: CertificationCheckoutInput, create: (authorization: CertificationAuthorization) => T): T | CertificationReplay {
    if (!input.idempotencyKey) throw new CertificationCapabilityError("CERTIFICATION_CHECKOUT_IDEMPOTENCY_KEY_REQUIRED");
    const work = this.db.transaction(() => {
      // Idempotency first, always. A retried request - a dropped response, a
      // resumed step re-run - must return the order it already made and must
      // not burn the one-shot capability on a request that creates nothing.
      const existing = this.orders.find(input.idempotencyKey);
      if (existing) {
        // A key belonging to another run is not a replay; it is one run
        // reaching into another's order, and returning it would hand over
        // someone else's purchase.
        if (existing.certificationRunId !== input.claim.runId) {
          throw new CertificationCapabilityError("CERTIFICATION_CHECKOUT_KEY_FOREIGN_RUN", existing.orderId);
        }
        return { kind: "REPLAY", order: existing } as CertificationReplay;
      }

      const run = this.runs.load(input.claim.runId);
      if (!run) throw new CertificationCapabilityError("CERTIFICATION_RUN_NOT_FOUND", input.claim.runId);
      if (run.phase !== "CHECKOUT_SUBMITTING") throw new CertificationCapabilityError("CERTIFICATION_RUN_NOT_CHECKING_OUT", run.phase);
      // A checkout admitted before the run recorded that money may exist is a
      // payment nobody wrote down first.
      if (!directionAtLeast(run.direction, "FINANCIAL_EFFECT_POSSIBLE")) {
        throw new CertificationCapabilityError("CERTIFICATION_RUN_FINANCIAL_EFFECT_NOT_ARMED", run.direction);
      }
      if (directionAtLeast(run.direction, "CLEANUP_STARTED")) {
        throw new CertificationCapabilityError("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN", run.direction);
      }

      const capability = this.capabilities.get(input.claim.capabilityId);
      const defect = authorizationDefect(capability, input.claim, input.facts, run, input.now);
      if (defect) throw new CertificationCapabilityError(defect);

      // Created while the capability is still unspent, then spent - in this one
      // transaction, so the order and the spend still commit together or not
      // at all. The other order made every certification checkout impossible:
      // `checkout` re-proves the authorization against the quote's own facts,
      // and a capability spent a moment earlier is, correctly, refused there.
      // A spend that fails after the order exists throws, and takes the order
      // with it.
      const created = create({ capability: capability!, run, facts: input.facts });
      this.capabilities.spend(input.claim.capabilityId, input.now);
      return created;
    });
    // Immediate, so two concurrent admissions contend for the write lock at the
    // first statement rather than discovering the conflict at COMMIT, after one
    // of them has already asked a provider for money.
    return this.db.inTransaction ? work() : work.immediate();
  }
}

/**
 * In production the ledger is not a second record. It is the checkout's own
 * permanent idempotency row, joined to the order's provenance.
 *
 * Writing a parallel ledger would create exactly the divergence the permanent
 * key exists to prevent: two answers to "what did this key already do", able to
 * disagree after a crash between them.
 */
export class SqliteCertificationOrderLedger implements CertificationOrderLedger {
  constructor(private readonly db: Database.Database) {}

  find(idempotencyKey: string): ExistingCertificationOrder | undefined {
    const row = this.db.prepare(`SELECT o.id AS order_id, o.public_status_id AS status_id, o.certification_run_id
      FROM checkout_idempotency ci JOIN orders o ON o.id = ci.order_id
      WHERE ci.idempotency_key_hash = ?`).get(sha256(idempotencyKey)) as
      { order_id: string; status_id: string; certification_run_id: string | null } | undefined;
    if (!row) return undefined;
    return {
      orderId: row.order_id,
      statusId: row.status_id,
      // An ordinary order has no run. Reporting that honestly is what makes an
      // ordinary customer's key read as a foreign run rather than as a replay
      // this run may collect.
      certificationRunId: row.certification_run_id ?? "",
    };
  }

  /**
   * Deliberately nothing. The checkout wrote `checkout_idempotency` and stamped
   * the order with its run inside the same transaction, so by the time this
   * would run the record already exists - and writing it again is how the two
   * copies start to disagree.
   */
  record(): void {}
}
