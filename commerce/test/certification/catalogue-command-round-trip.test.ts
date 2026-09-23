import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { issueCapability, type CertificationCapability } from "../../src/certification/capability";
import { HttpCertificationAdminPort } from "../../src/certification/http-ports";
import { certifyProduction, type CertifyPorts } from "../../src/certification/machine";
import { TerminalOperator } from "../../src/certification/operator-terminal";
import { readOperatorOccurrence } from "../../src/certification/operator-scope";
import { CERTIFICATION_OCCURRENCE_TITLE, CERTIFICATION_PRICE_KOPECKS, CERTIFICATION_TIMEZONE } from "../../src/certification/scope";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import { testSecret } from "../support/certification-secret";
import { certificationRuntime } from "../support/certification-runtime";

/**
 * The runner's armed command, taken all the way to the deployed runtime's
 * admission and back.
 *
 * Attempt 5, 2026-09-23: `certify` armed the release and its very first
 * catalogue command came back 500. The runtime had refused it as
 * CERTIFICATION_COMMAND_NOT_ARMED, because the runner armed
 * `{ ...drafted, cityId }` and the endpoint rebuilt `{ cityId, ...rest }` -
 * the same command, compared as JSON, in a different key order. Every test on
 * either side wrote the command by hand in the endpoint's order, so none of
 * them could see it.
 *
 * Nothing here is written by hand. The draft is read from an operator scope
 * file by the real reader, the machine arms it, the real HTTP port serializes
 * it, and the request body is parsed and admitted by the real endpoint against
 * the real SQLite authority - the functions the running commerce container
 * executes.
 */

const SHA = "c".repeat(40);
const SESSION = "deploy-session";
const RUN = "certification-deploy-session";
const now = new Date("2026-09-23T14:50:00.000Z");
const LEGAL = { version: "2026-08-28.1", manifestSha256: "f".repeat(64) };

let db: Database.Database;
let capability: CertificationCapability;
let bearer: string;
let candidate: ReleaseCandidate;
let scopePath: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city-1', 'kemerovo', 'Kemerovo')").run();
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'DEPLOYING', 'NEW_LINEAGE_ONLY',
      '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
      '2026-09-23T14:40:00.000Z', '2099-01-01T00:00:00.000Z', 1)`).run(SESSION, SHA, SHA);
  new SqliteCertificationRunStore(db).create({
    runId: RUN, revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt: now.toISOString(),
  });
  const issued = issueCapability(new SqliteCertificationCapabilityStore(db),
    { runId: RUN, deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: 4 * 60 * 60_000 }, now, testSecret());
  capability = issued.capability;
  bearer = issued.nonce;

  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((row) => row.version);
  candidate = {
    id: SHA, sha: SHA, releaseClass: "LAUNCH_BASELINE",
    expectation: { schemaInventory: schemaInventoryExpectation(versions), legalVersion: LEGAL.version, legalManifestSha256: LEGAL.manifestSha256 },
  };

  // The production scope file's shape, in the order an operator writes it.
  scopePath = join(mkdtempSync(join(tmpdir(), "certification-scope-")), "occurrence.json");
  writeFileSync(scopePath, JSON.stringify({
    starts_at: "2026-12-15T15:00:00.000Z", ends_at: "2026-12-15T18:00:00.000Z",
    venue_disclosure_text: "Точный адрес площадки сообщим участникам по электронной почте.",
    venue_announce_by: "2026-12-08T09:00:00.000Z",
  }));
});

describe("a runner-armed CREATE_OCCURRENCE crossing into the deployed runtime", () => {
  it("is admitted by the endpoint as the command the run armed", async () => {
    const fetch = certificationRuntime({ db, sha: SHA, now, citySlug: "kemerovo", legal: LEGAL });
    const admin = new HttpCertificationAdminPort({ baseUrl: "https://admin.invalid", token: "t", runId: RUN, fetch });
    admin.useClaim({ capabilityId: capability.id, runId: RUN, nonce: bearer });
    const terminal = { write: () => {}, readLine: () => "", close: () => {} };
    const ports: CertifyPorts = {
      admin,
      publicApi: { } as CertifyPorts["publicApi"],
      operator: new TerminalOperator({ occurrence: readOperatorOccurrence(scopePath), checkoutBodyPath: "/nonexistent" }, terminal),
      runs: new SqliteCertificationRunStore(db),
      clock: () => now,
      newIdempotencyKey: () => "40ab2104-1668-468e-beaf-6460744bc2aa",
      waitFor: async () => undefined,
    };

    const outcome = await certifyProduction(ports, {
      runId: RUN, candidate, capability, bearerNonce: bearer,
      scope: { citySlug: "kemerovo", title: CERTIFICATION_OCCURRENCE_TITLE, timezone: CERTIFICATION_TIMEZONE, priceKopecks: CERTIFICATION_PRICE_KOPECKS, capacity: 1 },
      citySlug: "kemerovo",
      timeouts: { paymentMs: 1, emailMs: 1, refundMs: 1 },
    });

    // The run goes on to fail further along, where this fixture stops
    // answering. What matters is the first step: the runtime admitted the
    // runner's command and recorded it in its own ledger.
    const ledger = db.prepare("SELECT command_kind, occurrence_id FROM certification_catalogue_mutations WHERE run_id = ? ORDER BY recorded_at")
      .all(RUN) as { command_kind: string; occurrence_id: string }[];
    expect(outcome.kind === "PASS" ? "" : outcome.code).not.toContain("CERTIFICATION_COMMAND_NOT_ARMED");
    expect(ledger[0]).toEqual({ command_kind: "CREATE_OCCURRENCE", occurrence_id: `occurrence-${RUN}` });
  });
});
