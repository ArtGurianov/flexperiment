import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { issueCapability } from "../../src/certification/capability";
import { ProductionCertificationDriver } from "../../src/certification/driver";
import { certificationRunId, retryRunId } from "../../src/certification/no-effect-retry";
import { readOperatorOccurrence } from "../../src/certification/operator-scope";
import type { CertificationRun } from "../../src/certification/run";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import { TEST_CAPABILITY_KEY, testSecret } from "../support/certification-secret";

/**
 * Attempt 5's durable state, reproduced row for row, and the one way forward
 * from it.
 *
 * `certify` armed the session - NEW_LINEAGE_ONLY, so no rollback - and its
 * first catalogue command was refused by the runtime. The run recorded an
 * immutable INCOMPLETE, shut a catalogue it had never opened, and can never
 * pass. Nothing left the system: no ledger row, no occurrence, no order, and a
 * capability nobody spent. That is exactly what the retry must be able to
 * prove, and every variation of it that proves less must be refused.
 *
 * The clock starts in 2020 so that "after expiry" is also true of the real
 * database clock, which the schema's retirement guard reads.
 */

const SHA = "d".repeat(40);
const SESSION = "e4cb1a91-5e8a-4e2b-8b40-9e8fbcadb557";
const BASE = certificationRunId(SESSION);
const RETRY = retryRunId(SESSION);
const T0 = new Date("2020-01-01T14:45:48.028Z");
const TTL = 4 * 60 * 60_000;
const LEGAL = { version: "2026-08-28.1", manifestSha256: "f".repeat(64) };

/** The armed command attempt 5 actually wrote: `cityId` last. */
const armedByAttempt5 = {
  kind: "CREATE_OCCURRENCE" as const,
  idempotencyKey: "40ab2104-1668-468e-beaf-6460744bc2aa",
  draft: {
    startsAt: "2026-12-15T15:00:00.000Z", endsAt: "2026-12-15T18:00:00.000Z",
    venueDisclosureText: "Точный адрес площадки сообщим участникам по электронной почте.",
    venueAnnounceBy: "2026-12-08T09:00:00.000Z", cityId: "city-1",
  },
};

const failedFirstRun = (over: Partial<CertificationRun> = {}): CertificationRun => ({
  runId: BASE, revision: 1, releaseSha: SHA, phase: "NEW", direction: "CATALOGUE_CLEAN",
  startedAt: T0.toISOString(), pendingCommand: null,
  supersededCommand: { command: armedByAttempt5, reason: "CLEANUP_SUPERSEDED_CATALOGUE_OPENING" },
  failure: {
    outcome: "INCOMPLETE",
    code: "CERTIFICATION_CATALOGUE_COMMAND_FAILED (500): {\"error\":{\"code\":\"INTERNAL_ERROR\"}}",
    recordedAt: new Date(T0.getTime() + 4 * 60_000).toISOString(),
  },
  ...over,
});

let db: Database.Database;
let clock: Date;
let candidate: ReleaseCandidate;
let scopePath: string;

const session = (over: { state?: string; gate?: 0 | 1; authority?: string } = {}) =>
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, observed_topology, created_at, lease_expires_at, deployment_gate_closed, mutation_observed)
    VALUES (?, 'ubuntu22:3673031', 'MAINTENANCE_CUTOVER', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
    SESSION, SHA, SHA, over.state ?? "RECOVERY_REQUIRED", over.authority ?? "NEW_LINEAGE_ONLY",
    JSON.stringify({ runtime: { frontend: "b".repeat(40), admin: "b".repeat(40), commerce: "b".repeat(40), worker: "b".repeat(40) }, controlPlane: { productionDeployRefSha: "b".repeat(40) } }),
    JSON.stringify({ runtime: { frontend: SHA, admin: SHA, commerce: SHA, worker: SHA }, controlPlane: { productionDeployRefSha: SHA } }),
    T0.toISOString(), T0.toISOString(), over.gate ?? 1,
  );

const world = (options: { run?: Partial<CertificationRun>; session?: Parameters<typeof session>[0] } = {}) => {
  session(options.session);
  new SqliteCertificationRunStore(db).create(failedFirstRun(options.run));
  issueCapability(new SqliteCertificationCapabilityStore(db),
    { runId: BASE, deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: TTL }, T0, testSecret());
};

const driver = () => new ProductionCertificationDriver({
  db, candidate,
  adminBaseUrl: "https://admin.invalid", publicBaseUrl: "https://public.invalid", serviceToken: "t",
  capabilityKey: TEST_CAPABILITY_KEY, citySlug: "kemerovo",
  operator: { occurrence: readOperatorOccurrence(scopePath), checkoutBodyPath: "/nonexistent" },
  terminal: () => ({ write: () => {}, readLine: () => "", close: () => {} }),
  now: () => clock,
  // The retry is durable state only. Nothing here may reach a runtime; the
  // real-router E2E is where a certification meets one.
  fetch: (async () => { throw new Error("NO_NETWORK_IN_RETRY_TESTS"); }) as typeof globalThis.fetch,
});

/** Every durable row the retry could write, for "unchanged" to be checked against. */
const snapshot = () => JSON.stringify({
  runs: db.prepare("SELECT * FROM certification_runs ORDER BY run_id").all(),
  capabilities: db.prepare("SELECT * FROM certification_capabilities ORDER BY id").all(),
  sessions: db.prepare("SELECT * FROM deploy_sessions").all(),
  ledger: db.prepare("SELECT * FROM certification_catalogue_mutations").all(),
});

const afterExpiry = () => { clock = new Date(T0.getTime() + TTL + 1_000); };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city-1', 'kemerovo', 'Kemerovo')").run();
  clock = new Date(T0.getTime() + 10 * 60_000);
  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((row) => row.version);
  candidate = {
    id: SHA, sha: SHA, releaseClass: "MAINTENANCE_REQUIRED",
    expectation: { schemaInventory: schemaInventoryExpectation(versions), legalVersion: LEGAL.version, legalManifestSha256: LEGAL.manifestSha256 },
  };
  scopePath = join(mkdtempSync(join(tmpdir(), "certification-scope-")), "occurrence.json");
  writeFileSync(scopePath, JSON.stringify({
    starts_at: armedByAttempt5.draft.startsAt, ends_at: armedByAttempt5.draft.endsAt,
    venue_disclosure_text: armedByAttempt5.draft.venueDisclosureText, venue_announce_by: armedByAttempt5.draft.venueAnnounceBy,
  }));
});

describe("a no-effect certification retry from attempt 5's durable state", () => {
  it("refuses while the first capability is still live, leaving the durable rows unchanged", () => {
    world();
    const before = snapshot();
    expect(() => driver().retryAfterNoEffectFailure(SESSION)).toThrow("CERTIFICATION_RETRY_CAPABILITY_STILL_LIVE");
    // Rolled back: the runs, capabilities, session and ledger rows are as they
    // were - no -a2 run, no capability, no retirement. (Row equality, not a
    // claim about the database file's bytes.)
    expect(snapshot()).toBe(before);
    expect(new SqliteCertificationRunStore(db).load(RETRY)).toBeUndefined();
  });

  it("after expiry retires, creates -a2 and issues its capability together", () => {
    world();
    afterExpiry();
    const certification = driver();
    expect(certification.retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_ISSUED" });

    const capabilities = db.prepare("SELECT run_id, deployment_session_id, release_sha, consumed_at, retired_at FROM certification_capabilities ORDER BY created_at, run_id")
      .all() as { run_id: string; deployment_session_id: string; release_sha: string; consumed_at: string | null; retired_at: string | null }[];
    expect(capabilities.find((row) => row.run_id === BASE)?.retired_at).not.toBeNull();
    const live = capabilities.filter((row) => !row.consumed_at && !row.retired_at);
    expect(live).toEqual([{ run_id: RETRY, deployment_session_id: SESSION, release_sha: SHA, consumed_at: null, retired_at: null }]);
    expect(new SqliteCertificationRunStore(db).load(RETRY)).toMatchObject({ phase: "NEW", direction: "NORMAL", releaseSha: SHA, failure: null });

    // `certify` picks up the retry's capability, not the first one.
    const capability = certification.recoverCapability(SESSION)!;
    expect(capability.runId).toBe(RETRY);

    // Whether -a2's commands then get through a runtime is not this test's
    // question: real-router-e2e.test.ts runs a certification through the real
    // app. What matters here is that nothing ran under the first run's name.
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_catalogue_mutations WHERE run_id = ?").get(BASE)).toEqual({ n: 0 });
  });

  it("is idempotent: a second certify continues -a2 and never makes -a3", () => {
    world();
    afterExpiry();
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_ISSUED" });
    const first = driver().recoverCapability(SESSION)!;
    const after = snapshot();

    // The runner died before certification started; the next one comes back.
    clock = new Date(clock.getTime() + 60_000);
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_EXISTS" });
    expect(snapshot()).toBe(after);
    expect(driver().recoverCapability(SESSION)!.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_runs").get()).toEqual({ n: 2 });
  });

  const liveCapabilities = () => db.prepare(`SELECT id, run_id, deployment_session_id, release_sha FROM certification_capabilities
    WHERE consumed_at IS NULL AND retired_at IS NULL`).all() as { id: string; run_id: string; deployment_session_id: string; release_sha: string }[];

  it("gives -a2 a new capability on the same run when its own expires unspent, and still never makes -a3", () => {
    // Created, then the runner died before certifying, and came back more
    // than a TTL later. Recovering the expired capability would be refused by
    // the runtime, and with no -a3 the session would be stuck again.
    world();
    afterExpiry();
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_ISSUED" });
    const firstA2 = driver().recoverCapability(SESSION)!;
    expect(firstA2.runId).toBe(RETRY);

    clock = new Date(Date.parse(firstA2.expiresAt) + 1_000);
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_CAPABILITY_REISSUED" });

    expect((db.prepare("SELECT run_id FROM certification_runs ORDER BY run_id").all() as { run_id: string }[]).map((row) => row.run_id))
      .toEqual([BASE, RETRY]);
    expect((db.prepare("SELECT retired_at FROM certification_capabilities WHERE id = ?").get(firstA2.id) as { retired_at: string | null }).retired_at)
      .not.toBeNull();
    const live = liveCapabilities();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ run_id: RETRY, deployment_session_id: SESSION, release_sha: SHA });
    expect(live[0].id).not.toBe(firstA2.id);
    expect(driver().recoverCapability(SESSION)!.id).toBe(live[0].id);

    // And a live replacement is simply continued.
    const settled = snapshot();
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_EXISTS" });
    expect(snapshot()).toBe(settled);
  });

  it("never replaces a spent -a2 capability, which is what the refund and cleanup continue with", () => {
    world();
    afterExpiry();
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_ISSUED" });
    const spent = driver().recoverCapability(SESSION)!;
    db.prepare("UPDATE certification_capabilities SET consumed_at = ? WHERE id = ?").run(clock.toISOString(), spent.id);

    clock = new Date(Date.parse(spent.expiresAt) + 1_000);
    const before = snapshot();
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_EXISTS" });
    expect(snapshot()).toBe(before);
    expect(liveCapabilities()).toEqual([]);
    expect(driver().recoverCapability(SESSION)!.id).toBe(spent.id);
  });

  it("fails closed on a capability shape no path produces", () => {
    world();
    afterExpiry();
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "RETRY_ISSUED" });
    // A spent -a2 capability and a second, unretired one beside it.
    const spent = driver().recoverCapability(SESSION)!;
    db.prepare("UPDATE certification_capabilities SET consumed_at = ? WHERE id = ?").run(clock.toISOString(), spent.id);
    issueCapability(new SqliteCertificationCapabilityStore(db),
      { runId: BASE, deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: TTL }, clock, testSecret());
    const before = snapshot();
    expect(() => driver().retryAfterNoEffectFailure(SESSION)).toThrow("CERTIFICATION_RETRY_CAPABILITY_CORRUPT");
    expect(snapshot()).toBe(before);
  });

  it("does nothing for a first run that has not failed", () => {
    world({ run: { failure: null, direction: "NORMAL", supersededCommand: null } });
    afterExpiry();
    const before = snapshot();
    expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "NOT_FAILED" });
    expect(snapshot()).toBe(before);
  });

  describe("refuses, fail-closed and without writing, when the first run may have done something", () => {
    const cases: [string, () => void, string][] = [
      ["a catalogue ledger row", () => {
        world();
        db.prepare(`INSERT INTO certification_catalogue_mutations(run_id, command_kind, command_id, occurrence_id, occurrence_json)
          VALUES (?, 'CREATE_OCCURRENCE', 'k', 'occurrence-x', '{}')`).run(BASE);
      }, "CATALOGUE_LEDGER_PRESENT"],
      ["an occurrence the run recorded", () => world({ run: { occurrenceId: "occurrence-x" } }), "RUN_EVIDENCE_occurrenceId"],
      ["an order the run recorded", () => world({ run: { orderId: "order-x" } }), "RUN_EVIDENCE_orderId"],
      ["a payment the run recorded", () => world({ run: { paymentId: "payment-x" } }), "RUN_EVIDENCE_paymentId"],
      ["a command still pending", () => world({ run: { pendingCommand: armedByAttempt5, supersededCommand: null } }), "RUN_COMMAND_PENDING"],
      ["a superseded checkout", () => world({ run: { supersededCommand: { command: { kind: "CREATE_CHECKOUT", idempotencyKey: "k", quoteId: "q", requestSha256: "0".repeat(64) }, reason: "CLEANUP_PROVED_CHECKOUT_ABSENT" } } }), "RUN_SUPERSEDED_CREATE_CHECKOUT"],
      ["a run that got past NEW", () => world({ run: { phase: "OCCURRENCE_CREATED" } }), "RUN_PHASE_OCCURRENCE_CREATED"],
      ["a spent capability", () => {
        world();
        db.prepare("UPDATE certification_capabilities SET consumed_at = ? WHERE run_id = ?").run(T0.toISOString(), BASE);
      }, "CAPABILITY_CONSUMED"],
      ["a session no longer armed", () => world({ session: { authority: "OLD_LINEAGE_ALLOWED" } }), "SESSION_AUTHORITY_OLD_LINEAGE_ALLOWED"],
      ["a session not in recovery", () => world({ session: { state: "DEPLOYING" } }), "SESSION_STATE_DEPLOYING"],
      ["an open gate", () => world({ session: { gate: 0 } }), "SESSION_GATE_OPEN"],
    ];
    for (const [name, arrange, reason] of cases) {
      it(name, () => {
        arrange();
        afterExpiry();
        const before = snapshot();
        expect(driver().retryAfterNoEffectFailure(SESSION)).toEqual({ kind: "INELIGIBLE", reason });
        expect(snapshot()).toBe(before);
        expect(new SqliteCertificationRunStore(db).load(RETRY)).toBeUndefined();
      });
    }
  });
});
