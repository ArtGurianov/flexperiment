import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProductionRelease, type ProductionRelease } from "../../src/release/production-runner";
import { verifyCutover } from "../../src/release/verify-cutover";
import { harness, recordInstance, type Harness } from "../support/production-runner-harness";

/**
 * The exit code of `certify` proves a process ended. This proves a deployment
 * finished, and it is the only thing that does.
 */

const NOW = new Date("2026-09-21T12:00:00.000Z");
const now = () => NOW;

let root: string;
let vps: Harness;
let release: ProductionRelease;

type Seed = {
  readonly gateClosed?: 0 | 1;
  readonly sessionState?: string;
  readonly salesStatus?: string;
  readonly visibility?: string;
  readonly phase?: string;
  readonly direction?: string;
};

/**
 * Built in the shape each case needs rather than mutated into it. The schema
 * refuses to reopen a terminal session's gate, or to leave an occurrence hidden
 * and open - so a test that edited its way into a bad state would be testing
 * the trigger, not the verification.
 */
const seed = async (over: Seed = {}) => {
  vps.serving.frontend = vps.targetSha;
  vps.serving.admin = vps.targetSha;
  recordInstance(vps.db, "COMMERCE", "api-1", vps.targetSha, NOW);
  recordInstance(vps.db, "WORKER", "worker-1", vps.targetSha, NOW, NOW.toISOString());
  vps.db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, observed_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES ('session', 'owner', 'MAINTENANCE_CUTOVER', ?, ?, ?, 'NEW_LINEAGE_ONLY',
      ?, ?, '2026-09-21T00:00:00.000Z', '2099-01-01T00:00:00.000Z', ?)`)
    .run(vps.targetSha, vps.targetSha, over.sessionState ?? "SUCCEEDED",
      JSON.stringify({ runtime: { frontend: vps.preSha, admin: vps.preSha, commerce: vps.preSha, worker: vps.preSha }, controlPlane: { productionDeployRefSha: vps.preSha } }),
      JSON.stringify({ runtime: { frontend: vps.targetSha, admin: vps.targetSha, commerce: vps.targetSha, worker: vps.targetSha }, controlPlane: { productionDeployRefSha: vps.targetSha } }),
      over.gateClosed ?? 0);
  vps.db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city', 'test-city', 'City')").run();
  vps.db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      venue_status, venue_disclosure_text, venue_announce_by, visibility, sales_status)
    VALUES ('occ', 'city', 'Certification', '2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', 'Europe/Moscow', 100, 1,
      'TO_BE_ANNOUNCED', 'Later', '2026-09-25T00:00:00.000Z', ?, ?)`)
    .run(over.visibility ?? "HIDDEN", over.salesStatus ?? "CLOSED");
  vps.db.prepare(`INSERT INTO certification_runs(run_id, revision, release_sha, phase, direction, started_at)
    VALUES ('certification-session', 2, ?, ?, ?, '2026-09-21T00:00:00.000Z')`)
    .run(vps.targetSha, over.phase ?? "COMPLETE", over.direction ?? "CATALOGUE_CLEAN");
  vps.db.prepare(`INSERT INTO certification_catalogue_mutations(run_id, command_kind, command_id, occurrence_id, occurrence_json)
    VALUES ('certification-session', 'CREATE_OCCURRENCE', 'command-1', 'occ', '{"id":"occ"}')`).run();
  vps.db.prepare(`INSERT INTO certification_capabilities(id, run_id, deployment_session_id, release_sha,
      max_amount_kopecks, expires_at, nonce, consumed_at)
    VALUES ('cap', 'certification-session', 'session', ?, 100, '2026-09-21T16:00:00.000Z', 'digest', '2026-09-21T10:00:00.000Z')`).run(vps.targetSha);
  release = buildProductionRelease(vps.config, { now });
  // The deploy pointer has to be where the release left it.
  await release.deployRef.compareAndSet(vps.preSha, vps.targetSha);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "release-runner-"));
  vps = await harness(root);
});

afterEach(async () => { release?.close(); await vps.close(); });

describe("proving a cutover actually finished", () => {
  it("passes only when production agrees with the record", async () => {
    await seed();
    const report = await verifyCutover(release, "session");
    expect(report.failures).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.checks).toMatchObject({
      session_succeeded: true, sales_gate_open: true, runtime_converged: true,
      deploy_pointer_at_target: true, certification_complete: true,
      certification_fixture_closed: true, certification_fixture_hidden: true, no_live_capability: true,
    });
  });

  it("fails when a surface drifted after the release settled", async () => {
    // Read now, never from the session's last recorded observation - which is
    // exactly what would hide this.
    await seed();
    vps.serving.admin = vps.preSha;
    const report = await verifyCutover(release, "session");
    expect(report.complete).toBe(false);
    expect(report.checks.runtime_converged).toBe(false);
  });

  it("fails a session that is still holding the fence", async () => {
    // A succeeded session with sales shut is not merely wrong, it is
    // unwritable: the schema refuses the combination, because settling and
    // reopening are one operation. What can exist is a session that never
    // settled, and verification has to call that unfinished.
    await seed({ sessionState: "DEPLOYING", gateClosed: 1 });
    const report = await verifyCutover(release, "session");
    expect(report.complete).toBe(false);
    expect(report.checks).toMatchObject({ session_succeeded: false, sales_gate_open: false });
  });

  it("fails when the certification fixture is still sellable or visible", async () => {
    // The ledger says a close was recorded; only the occurrence says it is shut.
    await seed({ visibility: "PUBLISHED", salesStatus: "OPEN" });
    const report = await verifyCutover(release, "session");
    expect(report.checks.certification_fixture_closed).toBe(false);
    expect(report.checks.certification_fixture_hidden).toBe(false);
    expect(report.complete).toBe(false);
  });

  it("fails when the certification did not reach the end", async () => {
    await seed({ phase: "REFUND_SUCCEEDED", direction: "FINANCIAL_EFFECT_POSSIBLE" });
    const report = await verifyCutover(release, "session");
    expect(report.checks.certification_complete).toBe(false);
    expect(report.failures.join(" ")).toContain("REFUND_SUCCEEDED");
  });

  it("fails while a capability is still live", async () => {
    // A capability that outlived its release is a permission to buy behind a
    // fence that is no longer there.
    await seed();
    vps.db.prepare("INSERT INTO certification_capabilities(id, run_id, deployment_session_id, release_sha, max_amount_kopecks, expires_at, nonce) VALUES ('cap-2', 'certification-session', 'session', ?, 100, '2099-01-01T00:00:00.000Z', 'digest-2')").run(vps.targetSha);
    expect((await verifyCutover(release, "session")).checks.no_live_capability).toBe(false);
  });

  it("changes nothing at all", async () => {
    await seed();
    const before = vps.db.prepare("SELECT state, deployment_gate_closed FROM deploy_sessions WHERE id = 'session'").get();
    const calls = vps.calls.length;
    await verifyCutover(release, "session");
    expect(vps.db.prepare("SELECT state, deployment_gate_closed FROM deploy_sessions WHERE id = 'session'").get()).toEqual(before);
    // It reads the descriptor surfaces; it asks Coolify for nothing.
    expect(vps.calls.length).toBe(calls);
  });

  it("refuses a session nobody started", async () => {
    await seed();
    await expect(verifyCutover(release, "absent")).rejects.toThrow("DEPLOY_SESSION_NOT_FOUND");
  });
});
