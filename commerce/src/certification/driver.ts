import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { issueCapability, type CertificationCapability } from "./capability";
import { certifyProduction, type CertifyPorts } from "./machine";
import { HttpCertificationAdminPort, HttpCertificationPublicPort } from "./http-ports";
import { TerminalOperator, type OperatorScope, type TerminalChannel } from "./operator-terminal";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "./store-sqlite";
import { CERTIFICATION_OCCURRENCE_TITLE, CERTIFICATION_PRICE_KOPECKS, CERTIFICATION_TIMEZONE } from "./scope";
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
  readonly citySlug: string;
  readonly operator: OperatorScope;
  readonly terminal: TerminalChannel;
  readonly now?: () => Date;
  readonly fetch?: typeof globalThis.fetch;
  readonly capabilityTtlMs?: number;
  readonly timeouts?: { readonly paymentMs: number; readonly emailMs: number; readonly refundMs: number };
};

/** One run per deploy session, so a restart continues rather than begins. */
export const certificationRunId = (deploymentSessionId: string): string => `certification-${deploymentSessionId}`;

const DEFAULT_TIMEOUTS = { paymentMs: 30 * 60_000, emailMs: 15 * 60_000, refundMs: 30 * 60_000 };

export class ProductionCertificationDriver implements CertificationDriver {
  #admin?: HttpCertificationAdminPort;
  #sessionId?: string;

  constructor(private readonly options: CertificationDriverOptions) {}

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
    return issueCapability(new SqliteCertificationCapabilityStore(this.options.db), {
      runId, deploymentSessionId: sessionId, releaseSha: this.options.candidate.sha,
      maxAmountKopecks: CERTIFICATION_PRICE_KOPECKS,
      ttlMs: this.options.capabilityTtlMs ?? 4 * 60 * 60_000,
    }, this.now());
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
    const admin = new HttpCertificationAdminPort({
      baseUrl: this.options.adminBaseUrl, token: this.options.serviceToken, runId, fetch: this.options.fetch,
    });
    admin.useClaim({ capabilityId: capability.id, runId, nonce: capability.nonce });
    this.#admin = admin;

    const ports: CertifyPorts = {
      admin,
      publicApi: new HttpCertificationPublicPort({ baseUrl: this.options.publicBaseUrl, fetch: this.options.fetch }),
      operator: new TerminalOperator(this.options.operator, this.options.terminal),
      runs: new SqliteCertificationRunStore(this.options.db),
      clock: this.now,
      // Random per command, and recorded before the request leaves. Deriving it
      // from the step would make two different attempts at one step look like
      // the same request to a provider that had already accepted one.
      newIdempotencyKey: () => randomUUID(),
      waitFor: this.waitFor.bind(this),
    };

    const outcome = await certifyProduction(ports, {
      runId, candidate: this.options.candidate, capability,
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

  /** What the run has reached, for a caller reporting progress without deciding anything. */
  phase(sessionId: string): string | undefined {
    return new SqliteCertificationRunStore(this.options.db).load(certificationRunId(sessionId))?.phase;
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
