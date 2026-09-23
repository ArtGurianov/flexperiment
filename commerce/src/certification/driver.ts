import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { capabilityBinding, CertificationCapabilityError, issueCapability, type CertificationCapability } from "./capability";
import { parseCapabilityKeyring, recoverCertificationNonce } from "./nonce";
import { assertAttended } from "./operator-terminal";
import { certifyProduction, type CertifyPorts } from "./machine";
import { HttpCertificationAdminPort, HttpCertificationPublicPort } from "./http-ports";
import { TerminalOperator, type OperatorScope, type TerminalChannel } from "./operator-terminal";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "./store-sqlite";
import { CERTIFICATION_OCCURRENCE_TITLE, CERTIFICATION_PRICE_KOPECKS, CERTIFICATION_TIMEZONE } from "./scope";
import { certificationRunId, effectiveCertificationRunId, noEffectDefect, retryRunId } from "./no-effect-retry";
import type { CertificationDriver } from "../release/orchestrator";
import type { ReleaseCandidate } from "../release/candidate";

/**
 * The production certification driver.
 *
 * Its durable state is the run record, the catalogue ledger and the checkout
 * idempotency row - all of them on the other side of a commit. Nothing about
 * where a certification got to lives in this process, so a runner that dies
 * between the payment and the refund is replaced by one that reads the same
 * three places and continues, rather than starting again.
 *
 * The run id is derived from the deploy session, not minted per attempt. A
 * fresh id per invocation would make every restart a new certification, which
 * is the one thing a real payment must never let happen.
 */

export type CertificationDriverOptions = {
  readonly db: Database.Database;
  readonly candidate: ReleaseCandidate;
  readonly adminBaseUrl: string;
  readonly publicBaseUrl: string;
  readonly serviceToken: string;
  /**
   * `<version>:<base64url key>`, newest first, whitespace or comma separated.
   * Only the runner holds it; the certified runtime never does.
   */
  readonly capabilityKey: string;
  readonly citySlug: string;
  readonly operator: OperatorScope;
  /**
   * The operator's terminal, opened on demand.
   *
   * A function rather than a channel because opening `/dev/tty` at
   * construction put the attendance requirement on the wrong side of
   * `AWAITING_OPERATOR`: `issueCapability` needs no terminal and creates no
   * external effect, but the driver could not be built without one, so an
   * unattended `deploy` could never reach exit 13 at all. Attendance is
   * asserted in `preflight`, which is before arming, and the channel opened
   * there is the one `certify` then uses.
   */
  readonly terminal: () => TerminalChannel;
  readonly now?: () => Date;
  readonly fetch?: typeof globalThis.fetch;
  readonly capabilityTtlMs?: number;
  readonly timeouts?: { readonly paymentMs: number; readonly emailMs: number; readonly refundMs: number };
};

/** One run per deploy session, so a restart continues rather than begins. See `no-effect-retry.ts` for the one exception. */
export { certificationRunId };

/**
 * What `retryAfterNoEffectFailure` found. RETRY_ISSUED and RETRY_CAPABILITY_REISSUED
 * wrote certification rows; the others changed nothing.
 *
 * INELIGIBLE is not an error: a first run that failed after doing something
 * still has to be reconciled - a captured payment refunded - and that is the
 * ordinary `certify` path, which the caller then takes.
 */
export type NoEffectRetryOutcome =
  | { readonly kind: "NOT_FAILED" }
  | { readonly kind: "RETRY_EXISTS" }
  /** `-a2`'s own capability had expired unspent; the same run was given a new one. */
  | { readonly kind: "RETRY_CAPABILITY_REISSUED" }
  | { readonly kind: "INELIGIBLE"; readonly reason: string }
  | { readonly kind: "RETRY_ISSUED" };

const DEFAULT_TIMEOUTS = { paymentMs: 30 * 60_000, emailMs: 15 * 60_000, refundMs: 30 * 60_000 };

export class ProductionCertificationDriver implements CertificationDriver {
  #admin?: HttpCertificationAdminPort;
  #sessionId?: string;
  #terminal?: TerminalChannel;

  constructor(private readonly options: CertificationDriverOptions) {}

  /**
   * One channel per driver, opened the first time attendance is required.
   *
   * Memoized so `preflight` and `certify` speak to the same terminal: proving
   * a terminal exists and then opening a different one later would prove
   * nothing about the operator who is actually there.
   */
  private openTerminal(): TerminalChannel {
    this.#terminal ??= this.options.terminal();
    return this.#terminal;
  }

  private get now(): () => Date { return this.options.now ?? (() => new Date()); }

  /**
   * Creates the run and the capability, and spends nothing.
   *
   * Both are records this system keeps about itself, so this is still before
   * the point of no return: a cutover prepared and never certified is still
   * rollback-legal. The run is created only if it does not exist, because a
   * second attempt for the same session is the same certification.
   */
  async issueCapability(sessionId: string): Promise<CertificationCapability> {
    this.#sessionId = sessionId;
    const runId = certificationRunId(sessionId);
    const runs = new SqliteCertificationRunStore(this.options.db);
    if (!runs.load(runId)) {
      runs.create({
        runId, revision: 1, releaseSha: this.options.candidate.sha,
        phase: "NEW", direction: "NORMAL", startedAt: this.now().toISOString(),
      });
    }
    const { capability } = issueCapability(new SqliteCertificationCapabilityStore(this.options.db), {
      runId, deploymentSessionId: sessionId, releaseSha: this.options.candidate.sha,
      maxAmountKopecks: CERTIFICATION_PRICE_KOPECKS,
      ttlMs: this.options.capabilityTtlMs ?? 4 * 60 * 60_000,
    }, this.now(), this.issuingKey());
    // The bearer is deliberately dropped here. It is derived again when it is
    // needed, so nothing carries it between these two moments.
    return capability;
  }

  private keyring() { return parseCapabilityKeyring(this.options.capabilityKey); }

  /** New capabilities are issued under the newest key; old ones stay derivable under theirs. */
  private issuingKey() { return this.keyring()[0]; }

  /**
   * The bearer for a capability, recomputed from its own binding.
   *
   * The ring is searched rather than indexed, because the version lives inside
   * the bearer and the bearer is the thing that was never kept. A capability
   * whose key has been retired has no bearer, and that is a refusal rather than
   * a guess.
   */
  bearerFor(capability: CertificationCapability): string {
    const nonce = recoverCertificationNonce(this.keyring(), capabilityBinding(capability), capability.nonceDigest);
    if (!nonce) throw new Error("CERTIFICATION_CAPABILITY_KEY_MISSING");
    return nonce;
  }

  /**
   * Everything that can be checked without changing anything outside this
   * system, done before the point of no return.
   *
   * A runtime that cannot be reached, a capability that is gone, a catalogue
   * that is not ready or an unattended terminal are all ordinary refusals - and
   * they must stay ordinary. Arming first would spend the release's last
   * reversible step on a precondition, leaving a cutover that cannot be rolled
   * back and has not certified anything.
   */
  async preflight(capability: CertificationCapability): Promise<void> {
    const recovered = this.recoverCapability(capability.deploymentSessionId);
    if (!recovered || recovered.id !== capability.id) {
      throw new Error("CERTIFICATION_CAPABILITY_UNRECOVERABLE");
    }
    // Derivable at all: a ring that cannot reproduce the stored digest has lost
    // the key this capability was issued under, and finding that out after
    // arming would be finding it out too late.
    this.bearerFor(recovered);
    // Opened here, before anything can be armed - not first reached after it.
    // Retained, so `certify` speaks on the channel whose presence was proved.
    this.openTerminal();

    const runs = new SqliteCertificationRunStore(this.options.db);
    const run = runs.load(capability.runId);
    if (!run) throw new Error("CERTIFICATION_RUN_NOT_FOUND");
    if (run.releaseSha !== this.options.candidate.sha) throw new Error("CERTIFICATION_RUN_RELEASE_MISMATCH");

    // Read-only, and against the runtime being certified rather than against
    // this process's own database.
    const admin = this.admin(capability);
    const evidence = await admin.systemEvidence();
    if (evidence.schema.lineage !== "SUPPORTED") throw new Error(`CERTIFICATION_LINEAGE_${evidence.schema.lineage}`);
    if (!await admin.cityIdBySlug(this.options.citySlug)) throw new Error("CERTIFICATION_CITY_ABSENT");
  }

  private admin(capability: CertificationCapability): HttpCertificationAdminPort {
    const admin = new HttpCertificationAdminPort({
      baseUrl: this.options.adminBaseUrl, token: this.options.serviceToken,
      runId: capability.runId, fetch: this.options.fetch,
    });
    admin.useClaim({ capabilityId: capability.id, runId: capability.runId, nonce: this.bearerFor(capability) });
    return admin;
  }

  /**
   * The attended run, end to end, against the deployed runtime.
   *
   * A machine outcome that is not PASS is thrown rather than returned: the
   * orchestrator's contract is that a failing certification leaves the session
   * in recovery with sales shut, and an INCOMPLETE that read as success would
   * reopen a shop over an unreconciled payment.
   */
  async certify(capability: CertificationCapability): Promise<void> {
    const runId = capability.runId;
    const admin = this.admin(capability);
    this.#admin = admin;

    const ports: CertifyPorts = {
      admin,
      publicApi: new HttpCertificationPublicPort({ baseUrl: this.options.publicBaseUrl, fetch: this.options.fetch }),
      operator: new TerminalOperator(this.options.operator, this.openTerminal()),
      runs: new SqliteCertificationRunStore(this.options.db),
      clock: this.now,
      // Random per command, and recorded before the request leaves. Deriving it
      // from the step would make two different attempts at one step look like
      // the same request to a provider that had already accepted one.
      newIdempotencyKey: () => randomUUID(),
      waitFor: this.waitFor.bind(this),
    };

    const outcome = await certifyProduction(ports, {
      runId, candidate: this.options.candidate, capability, bearerNonce: this.bearerFor(capability),
      scope: {
        citySlug: this.options.citySlug, title: CERTIFICATION_OCCURRENCE_TITLE,
        timezone: CERTIFICATION_TIMEZONE, priceKopecks: CERTIFICATION_PRICE_KOPECKS, capacity: 1,
      },
      citySlug: this.options.citySlug,
      timeouts: this.options.timeouts ?? DEFAULT_TIMEOUTS,
    });
    if (outcome.kind !== "PASS") throw new Error(`${outcome.kind}:${outcome.code}`);
  }

  /**
   * The capability a previous process issued, recovered for this one.
   *
   * `prepare` exits and the process is gone; `certify` starts fresh minutes or
   * hours later and has to present the same bearer. It is recovered from the
   * capability row rather than re-issued, because a new capability per attempt
   * would mean a new authorization for every restart - and the one that already
   * exists is the one the run's checkout is idempotent against.
   *
   * The row of a spent capability is returned too. After the checkout, the run
   * still needs it: the claim identifies the caller to the catalogue endpoint
   * for the close, and the checkout itself replays through its idempotency key
   * without touching the capability again.
   */
  recoverCapability(sessionId: string): CertificationCapability | undefined {
    const row = this.options.db.prepare(`SELECT id FROM certification_capabilities
      WHERE deployment_session_id = ? AND retired_at IS NULL
      ORDER BY consumed_at IS NULL DESC, created_at DESC LIMIT 1`).get(sessionId) as { id: string } | undefined;
    if (!row) return undefined;
    return new SqliteCertificationCapabilityStore(this.options.db).get(row.id);
  }

  /**
   * The session's one retry, if its first certification provably did nothing.
   *
   * Everything happens in one IMMEDIATE transaction: the proof is re-read, the
   * `-a2` run is created and its capability issued, and the store's issuance
   * retires the first capability in the same write. A throw anywhere rolls all
   * of it back, so there is never an `-a2` run without a capability, or a
   * retired capability without a replacement.
   *
   * The first capability is never retired early. The schema allows retirement
   * only once it has expired, by the database's own clock, and that is kept
   * rather than worked around: until then this refuses with
   * CERTIFICATION_RETRY_CAPABILITY_STILL_LIVE and changes nothing.
   *
   * Idempotent: once `-a2` exists, a later `certify` is continuing it, and no
   * run is ever created again. There is no `-a3`. What `-a2` may still need is
   * a capability: a runner that died after creating it and came back more than
   * a TTL later would otherwise recover an expired one and be refused by the
   * runtime, stuck exactly as attempt 5 was. So an unspent, expired `-a2`
   * capability is replaced on the same run, through the same store issuance
   * and the same database-clock guard. A spent one is never replaced: the
   * checkout already happened under it, and it is the identity the refund and
   * cleanup continue with.
   */
  retryAfterNoEffectFailure(sessionId: string): NoEffectRetryOutcome {
    const runs = new SqliteCertificationRunStore(this.options.db);
    const retry = retryRunId(sessionId);
    const work = this.options.db.transaction((): NoEffectRetryOutcome => {
      if (runs.load(retry)) return this.continueRetry(sessionId, retry);
      const first = runs.load(certificationRunId(sessionId));
      if (!first?.failure) return { kind: "NOT_FAILED" };
      const defect = noEffectDefect(this.options.db, sessionId, first, this.options.candidate);
      if (defect) return { kind: "INELIGIBLE", reason: defect };

      runs.create({
        runId: retry, revision: 1, releaseSha: this.options.candidate.sha,
        phase: "NEW", direction: "NORMAL", startedAt: this.now().toISOString(),
      });
      try {
        issueCapability(new SqliteCertificationCapabilityStore(this.options.db), {
          runId: retry, deploymentSessionId: sessionId, releaseSha: this.options.candidate.sha,
          maxAmountKopecks: CERTIFICATION_PRICE_KOPECKS,
          ttlMs: this.options.capabilityTtlMs ?? 4 * 60 * 60_000,
        }, this.now(), this.issuingKey());
      } catch (error) {
        if (error instanceof CertificationCapabilityError && error.code === "CERTIFICATION_CAPABILITY_ALREADY_LIVE") {
          const live = this.options.db.prepare("SELECT expires_at FROM certification_capabilities WHERE id = ?")
            .get(error.detail ?? "") as { expires_at: string } | undefined;
          throw new CertificationCapabilityError("CERTIFICATION_RETRY_CAPABILITY_STILL_LIVE",
            `${error.detail ?? "unknown"} expires ${live?.expires_at ?? "unknown"}; retry after that`);
        }
        throw error;
      }
      return { kind: "RETRY_ISSUED" };
    });
    return work.immediate();
  }

  /** `-a2` exists: keep it certifiable, and never make another run. Runs inside the caller's transaction. */
  private continueRetry(sessionId: string, retry: string): NoEffectRetryOutcome {
    const held = this.options.db.prepare(`SELECT id, run_id, release_sha, consumed_at, expires_at FROM certification_capabilities
      WHERE deployment_session_id = ? AND retired_at IS NULL`).all(sessionId) as
      { id: string; run_id: string; release_sha: string; consumed_at: string | null; expires_at: string }[];
    // One capability standing for the session, and it is `-a2`'s. Anything
    // else is a shape no path here produces, and guessing which one to trust
    // is how a second authorization would come to exist.
    if (held.length !== 1 || held[0].run_id !== retry || held[0].release_sha !== this.options.candidate.sha) {
      throw new CertificationCapabilityError("CERTIFICATION_RETRY_CAPABILITY_CORRUPT",
        held.map((row) => `${row.id}:${row.run_id}`).join(",") || "none");
    }
    const [capability] = held;
    if (capability.consumed_at) return { kind: "RETRY_EXISTS" };
    if (Date.parse(capability.expires_at) > this.now().getTime()) return { kind: "RETRY_EXISTS" };
    issueCapability(new SqliteCertificationCapabilityStore(this.options.db), {
      runId: retry, deploymentSessionId: sessionId, releaseSha: this.options.candidate.sha,
      maxAmountKopecks: CERTIFICATION_PRICE_KOPECKS,
      ttlMs: this.options.capabilityTtlMs ?? 4 * 60 * 60_000,
    }, this.now(), this.issuingKey());
    return { kind: "RETRY_CAPABILITY_REISSUED" };
  }

  /** What the run has reached, for a caller reporting progress without deciding anything. */
  phase(sessionId: string): string | undefined {
    return new SqliteCertificationRunStore(this.options.db).load(effectiveCertificationRunId(this.options.db, sessionId))?.phase;
  }

  /**
   * Polls until the deadline, then gives up.
   *
   * Returning undefined rather than throwing is the machine's contract for "not
   * resolved", which is different from "did not happen": a payment that has not
   * settled within the window is incomplete, never failed.
   */
  private async waitFor<T>(poll: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
    const deadline = this.now().getTime() + timeoutMs;
    for (;;) {
      const answer = await poll();
      if (answer !== undefined) return answer;
      if (this.now().getTime() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  /** Exposed for the runner's own reporting; never used to decide anything. */
  get sessionId(): string | undefined { return this.#sessionId; }
  get adminPort(): HttpCertificationAdminPort | undefined { return this.#admin; }
}
