import Database from "better-sqlite3";
import { migrate } from "../../src/db";
import { InMemoryCertificationCapabilityStore, type CertificationCapabilityStore } from "../../src/certification/capability";
import { InMemoryCertificationRunStore, type CertificationRunStore } from "../../src/certification/run";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";

const launchDatabase = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
};

/**
 * Both run stores, so the contract suite runs against each. A capability is
 * bound by foreign key to its run and its deployment session, so the SQLite
 * factory has to make those exist before a capability can.
 */
export const certificationRunStores: ReadonlyArray<readonly [string, () => CertificationRunStore]> = [
  ["in-memory", () => new InMemoryCertificationRunStore()],
  ["sqlite", () => new SqliteCertificationRunStore(launchDatabase())],
];

export type CapabilityFixture = {
  readonly store: CertificationCapabilityStore & { spend(id: string, now: Date): unknown };
  /** Makes the run and session a capability's foreign keys point at. */
  readonly bind: (runId: string, deploymentSessionId: string) => void;
};

export const certificationCapabilityStores: ReadonlyArray<readonly [string, () => CapabilityFixture]> = [
  ["in-memory", () => ({ store: new InMemoryCertificationCapabilityStore(), bind: () => {} })],
  ["sqlite", () => {
    const db = launchDatabase();
    const bound = new Set<string>();
    return {
      store: new SqliteCertificationCapabilityStore(db),
      bind: (runId: string, deploymentSessionId: string) => {
        if (!bound.has(`run:${runId}`)) {
          db.prepare(`INSERT INTO certification_runs(run_id, revision, release_sha, phase, direction, started_at)
            VALUES (?, 1, ?, 'NEW', 'NORMAL', '2026-01-01T00:00:00.000Z')`).run(runId, "a".repeat(40));
          bound.add(`run:${runId}`);
        }
        if (!bound.has(`session:${deploymentSessionId}`)) {
          db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, state, rollback_authority,
              pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
            VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, 'FENCED', 'OLD_LINEAGE_ALLOWED', '{}',
              '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 1)`)
            .run(deploymentSessionId, "a".repeat(40));
          bound.add(`session:${deploymentSessionId}`);
        }
      },
    };
  }],
];
