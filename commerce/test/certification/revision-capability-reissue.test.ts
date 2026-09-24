import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { issueCapability } from "../../src/certification/capability";
import { ProductionCertificationDriver } from "../../src/certification/driver";
import { revisionRunId } from "../../src/certification/no-effect-retry";
import { readOperatorOccurrence } from "../../src/certification/operator-scope";
import type { CertificationRun } from "../../src/certification/run";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import { TEST_CAPABILITY_KEY, testSecret } from "../support/certification-secret";
import { CERTIFICATION_CAPABILITY_TTL_MS } from "../../src/certification/scope";

/**
 * A forward revision whose capability expired before anyone spent it.
 *
 * `forward-deploy` issues revision N its run and one capability. If the
 * operator starts `certify` after that capability's TTL, preflight refuses it,
 * and running `forward-deploy` again with the same commit only finds the
 * existing run: the session could be finished only by a new commit and a new
 * revision. This is the same-run reissue `-a2` already had, for revisions.
 *
 * The clock starts in 2020 so that "after expiry" is also true of the real
 * database clock, which the schema's retirement guard reads.
 */

const ORIGINAL = "a".repeat(40);
const SHA = "d".repeat(40);
const SESSION = "5a1e5510-0000-4000-8000-000000000001";
const RUN = revisionRunId(SESSION, 1);
const T0 = new Date("2020-01-01T10:00:00.000Z");
const TTL = 4 * 60 * 60_000;
const LEGAL = { version: "2026-08-28.1", manifestSha256: "f".repeat(64) };

let db: Database.Database;
let clock: Date;
let candidate: ReleaseCandidate;
let scopePath: string;

const topology = (sha: string) => JSON.stringify({ runtime: { frontend: sha, admin: sha, commerce: sha, worker: sha }, controlPlane: { productionDeployRefSha: sha } });

/** Revision 1 exactly as forward-deploy leaves it: armed, stuck, fenced, its run fresh, one capability. */
const world = (options: { run?: Partial<CertificationRun>; state?: string; revision?: boolean; revisionTarget?: string; ttlMs?: number } = {}) => {
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, observed_topology, created_at, lease_expires_at, deployment_gate_closed, mutation_observed)
    VALUES (?, 'runner', 'MAINTENANCE_CUTOVER', ?, ?, ?, 'NEW_LINEAGE_ONLY', ?, ?, ?, ?, ?, 1)`).run(
    SESSION, ORIGINAL, ORIGINAL, "RECOVERY_REQUIRED", topology("b".repeat(40)), topology(SHA),
    T0.toISOString(), T0.toISOString(), 1,
  );
  if (options.revision !== false) {
    db.prepare(`INSERT INTO deploy_session_forward_targets(session_id, revision, from_sha, target_sha, candidate_id, ci_evidence)
      VALUES (?, 1, ?, ?, ?, '{}')`).run(SESSION, ORIGINAL, options.revisionTarget ?? SHA, options.revisionTarget ?? SHA);
  }
  // A session is carried forward while stuck and settles afterwards; the
  // schema will not add a revision to a settled one.
  if (options.state === "SUCCEEDED") {
    db.prepare("UPDATE deploy_sessions SET state = 'SUCCEEDED', deployment_gate_closed = 0 WHERE id = ?").run(SESSION);
  }
  new SqliteCertificationRunStore(db).create({
    runId: RUN, revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt: T0.toISOString(), ...options.run,
  });
  return issueCapability(new SqliteCertificationCapabilityStore(db),
    { runId: RUN, deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: options.ttlMs ?? TTL }, T0, testSecret()).capability;
};

const driver = () => new ProductionCertificationDriver({
  db, candidate,
  adminBaseUrl: "https://admin.invalid", publicBaseUrl: "https://public.invalid", serviceToken: "t",
  capabilityKey: TEST_CAPABILITY_KEY, citySlug: "kemerovo",
  operator: { occurrence: readOperatorOccurrence(scopePath), checkoutBodyPath: "/nonexistent" },
  terminal: () => ({ write: () => {}, readLine: () => "", close: () => {} }),
  now: () => clock,
  fetch: (async () => { throw new Error("NO_NETWORK_IN_REISSUE_TESTS"); }) as typeof globalThis.fetch,
});

const snapshot = () => JSON.stringify({
  runs: db.prepare("SELECT * FROM certification_runs ORDER BY run_id").all(),
  capabilities: db.prepare("SELECT * FROM certification_capabilities ORDER BY id").all(),
  sessions: db.prepare("SELECT * FROM deploy_sessions").all(),
  targets: db.prepare("SELECT * FROM deploy_session_forward_targets").all(),
});
const capabilities = () => db.prepare(`SELECT id, run_id, release_sha, consumed_at, retired_at, retirement_reason
  FROM certification_capabilities ORDER BY created_at, id`).all() as
  { id: string; run_id: string; release_sha: string; consumed_at: string | null; retired_at: string | null; retirement_reason: string | null }[];
const live = () => capabilities().filter((row) => !row.consumed_at && !row.retired_at);
const afterExpiry = () => { clock = new Date(T0.getTime() + TTL + 1_000); };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  clock = new Date(T0.getTime() + 10 * 60_000);
  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((row) => row.version);
  candidate = {
    id: SHA, sha: SHA, releaseClass: "MAINTENANCE_REQUIRED",
    expectation: { schemaInventory: schemaInventoryExpectation(versions), legalVersion: LEGAL.version, legalManifestSha256: LEGAL.manifestSha256 },
  };
  scopePath = join(mkdtempSync(join(tmpdir(), "certification-scope-")), "occurrence.json");
  writeFileSync(scopePath, JSON.stringify({
    starts_at: "2026-12-15T15:00:00.000Z", ends_at: "2026-12-15T18:00:00.000Z",
    venue_disclosure_text: "Точный адрес площадки сообщим участникам по электронной почте.", venue_announce_by: "2026-12-08T09:00:00.000Z",
  }));
});

describe("reissuing an expired, unspent revision capability", () => {
  it("leaves a live capability alone", () => {
    world();
    const before = snapshot();
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "CAPABILITY_LIVE" });
    expect(snapshot()).toBe(before);
  });

  it("after expiry retires the old one and issues the only live capability, on the same run", () => {
    const first = world();
    const runBefore = JSON.stringify(new SqliteCertificationRunStore(db).load(RUN));
    afterExpiry();
    const certification = driver();
    expect(certification.reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "REISSUED" });

    const rows = capabilities();
    expect(rows.find((row) => row.id === first.id)).toMatchObject({ consumed_at: null, retirement_reason: "EXPIRED_REPLACED" });
    expect(rows.find((row) => row.id === first.id)?.retired_at).not.toBeNull();
    expect(live()).toEqual([expect.objectContaining({ run_id: RUN, release_sha: SHA })]);
    expect(live()[0].id).not.toBe(first.id);
    // Same run, same revision, same release: no new run, no new forward target.
    expect(JSON.stringify(new SqliteCertificationRunStore(db).load(RUN))).toBe(runBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_runs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM deploy_session_forward_targets").get()).toEqual({ n: 1 });
    // `certify` picks up the new one.
    expect(certification.recoverCapability(SESSION)?.id).toBe(live()[0].id);
  });

  it("is idempotent: a second call finds the reissued capability live and writes nothing", () => {
    world();
    afterExpiry();
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "REISSUED" });
    const after = snapshot();
    clock = new Date(clock.getTime() + 60_000);
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "CAPABILITY_LIVE" });
    expect(snapshot()).toBe(after);
  });

  it("never replaces a spent capability: the checkout happened under it", () => {
    const first = world();
    new SqliteCertificationCapabilityStore(db).spend(first.id, new Date(T0.getTime() + 60_000));
    afterExpiry();
    const before = snapshot();
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "INELIGIBLE", reason: "CAPABILITY_SPENT" });
    expect(snapshot()).toBe(before);
  });

  const refusals: [string, Parameters<typeof world>[0], string][] = [
    ["a run with payment evidence", { run: { orderId: "order-1" } }, "RUN_EVIDENCE_orderId"],
    ["a run with a command in flight", { run: { pendingCommand: { kind: "OPEN_SALES", idempotencyKey: "k", occurrenceId: "o" } as never } }, "RUN_COMMAND_PENDING"],
    ["a failed run", { run: { failure: { outcome: "INCOMPLETE", code: "X", recordedAt: T0.toISOString() } } }, "RUN_FAILED"],
    ["a settled session", { state: "SUCCEEDED" }, "SESSION_STATE_SUCCEEDED"],
  ];
  for (const [name, options, reason] of refusals) {
    it(`refuses ${name}, and writes nothing`, () => {
      world(options);
      afterExpiry();
      const before = snapshot();
      expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "INELIGIBLE", reason });
      expect(snapshot()).toBe(before);
    });
  }

  it("does not apply to a session's own target: that is the no-effect retry's", () => {
    world({ revision: false });
    afterExpiry();
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "NOT_APPLICABLE" });
  });

  it("refuses a capability that is not the current revision's", () => {
    // The revision is another release; this capability is not its. A shape no
    // path produces, and guessing which one to trust is how a second
    // authorization would come to exist.
    world({ revisionTarget: "e".repeat(40) });
    afterExpiry();
    const before = snapshot();
    expect(driver().reissueExpiredRevisionCapability(SESSION).kind).toBe("INELIGIBLE");
    expect(snapshot()).toBe(before);
  });

  /**
   * The lineage the launch actually walked: earlier revisions certified with a
   * real payment, refunded, and superseded. Their spent capabilities are never
   * retired - spent and retired are different endings - so they stay
   * non-retired history beside the current revision's.
   */
  const lineage = (paidRevisions: number) => {
    const shas = ["1", "2", "3", "4"].map((c) => c.repeat(40));
    db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
        pre_deploy_topology, observed_topology, created_at, lease_expires_at, deployment_gate_closed, mutation_observed)
      VALUES (?, 'runner', 'MAINTENANCE_CUTOVER', ?, ?, 'RECOVERY_REQUIRED', 'NEW_LINEAGE_ONLY', ?, ?, ?, ?, 1, 1)`).run(
      SESSION, ORIGINAL, ORIGINAL, topology("b".repeat(40)), topology(ORIGINAL), T0.toISOString(), T0.toISOString());
    const runs = new SqliteCertificationRunStore(db);
    const spent: string[] = [];
    let from = ORIGINAL;
    for (let revision = 1; revision <= paidRevisions + 1; revision += 1) {
      const current = revision === paidRevisions + 1;
      const sha = current ? SHA : shas[revision - 1];
      db.prepare(`INSERT INTO deploy_session_forward_targets(session_id, revision, from_sha, target_sha, candidate_id, ci_evidence)
        VALUES (?, ?, ?, ?, ?, '{}')`).run(SESSION, revision, from, sha, sha);
      runs.create({
        runId: revisionRunId(SESSION, revision), revision: 1, releaseSha: sha, phase: current ? "NEW" : "PAYMENT_PROVEN",
        direction: current ? "NORMAL" : "CATALOGUE_CLEAN", startedAt: T0.toISOString(),
        ...(current ? {} : { orderId: `order-${revision}`, paymentId: `payment-${revision}`, failure: { outcome: "INCOMPLETE", code: "CERTIFICATION_EMAIL_TIMEOUT:TICKET", recordedAt: T0.toISOString() } }),
      });
      const { capability } = issueCapability(new SqliteCertificationCapabilityStore(db),
        { runId: revisionRunId(SESSION, revision), deploymentSessionId: SESSION, releaseSha: sha, maxAmountKopecks: 100, ttlMs: TTL }, T0, testSecret());
      if (!current) {
        new SqliteCertificationCapabilityStore(db).spend(capability.id, new Date(T0.getTime() + 60_000));
        spent.push(capability.id);
      }
      from = sha;
    }
    return { spent, current: revisionRunId(SESSION, paidRevisions + 1) };
  };

  for (const paid of [1, 2]) {
    it(`reissues the current revision's capability beside ${paid} paid, spent revision${paid > 1 ? "s" : ""}`, () => {
      const { spent, current } = lineage(paid);
      const history = () => db.prepare(`SELECT id, consumed_at, retired_at, retirement_reason FROM certification_capabilities
        WHERE id IN (${spent.map(() => "?").join(", ")}) ORDER BY id`).all(...spent);
      const spentBefore = JSON.stringify(history());
      const old = live()[0];
      afterExpiry();

      expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "REISSUED" });
      // The paid history is untouched...
      expect(JSON.stringify(history())).toBe(spentBefore);
      // ...the current revision's expired capability is replaced...
      expect(capabilities().find((row) => row.id === old.id)).toMatchObject({ retirement_reason: "EXPIRED_REPLACED" });
      // ...and the one unspent, unretired slot is the replacement, on the current run.
      expect(live()).toEqual([expect.objectContaining({ run_id: current, release_sha: SHA })]);
      expect(live()[0].id).not.toBe(old.id);
    });
  }

  it("will not quietly replace a foreign capability that holds the session's slot", () => {
    // Revision 1's capability, unspent and expired, still holds the session's
    // one live slot, and the current revision's run has none of its own - a
    // shape no path produces. issueCapability would retire the foreign one
    // silently; the reissue refuses and writes nothing.
    db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
        pre_deploy_topology, observed_topology, created_at, lease_expires_at, deployment_gate_closed, mutation_observed)
      VALUES (?, 'runner', 'MAINTENANCE_CUTOVER', ?, ?, 'RECOVERY_REQUIRED', 'NEW_LINEAGE_ONLY', ?, ?, ?, ?, 1, 1)`).run(
      SESSION, ORIGINAL, ORIGINAL, topology("b".repeat(40)), topology(ORIGINAL), T0.toISOString(), T0.toISOString());
    const previous = "1".repeat(40);
    const target = db.prepare(`INSERT INTO deploy_session_forward_targets(session_id, revision, from_sha, target_sha, candidate_id, ci_evidence)
      VALUES (?, ?, ?, ?, ?, '{}')`);
    target.run(SESSION, 1, ORIGINAL, previous, previous);
    target.run(SESSION, 2, previous, SHA, SHA);
    const runs = new SqliteCertificationRunStore(db);
    runs.create({ runId: revisionRunId(SESSION, 1), revision: 1, releaseSha: previous, phase: "NEW", direction: "NORMAL", startedAt: T0.toISOString() });
    runs.create({ runId: revisionRunId(SESSION, 2), revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt: T0.toISOString() });
    issueCapability(new SqliteCertificationCapabilityStore(db),
      { runId: revisionRunId(SESSION, 1), deploymentSessionId: SESSION, releaseSha: previous, maxAmountKopecks: 100, ttlMs: TTL }, T0, testSecret());
    afterExpiry();
    const before = snapshot();
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "INELIGIBLE", reason: "CAPABILITY_COUNT_0" });
    expect(snapshot()).toBe(before);
  });

  it("with the production lifetime: live until the hour is up, then reissued for another hour", () => {
    world({ ttlMs: CERTIFICATION_CAPABILITY_TTL_MS });
    clock = new Date(T0.getTime() + CERTIFICATION_CAPABILITY_TTL_MS - 1);
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "CAPABILITY_LIVE" });
    clock = new Date(T0.getTime() + CERTIFICATION_CAPABILITY_TTL_MS + 1_000);
    expect(driver().reissueExpiredRevisionCapability(SESSION)).toEqual({ kind: "REISSUED" });
    const replacement = db.prepare("SELECT expires_at FROM certification_capabilities WHERE consumed_at IS NULL AND retired_at IS NULL").get() as { expires_at: string };
    expect(Date.parse(replacement.expires_at)).toBe(clock.getTime() + CERTIFICATION_CAPABILITY_TTL_MS);
  });
});

