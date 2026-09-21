import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { issueCapability } from "../../src/certification/capability";
import {
  certificationNonceDigest, deriveCertificationNonce, nonceDigestMatches, parseCapabilityKey,
} from "../../src/certification/nonce";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import { testSecret, TEST_CAPABILITY_KEY } from "../support/certification-secret";

const SHA = "a".repeat(40);
const now = new Date("2026-09-21T12:00:00.000Z");
const binding = {
  capabilityId: "cap-1", runId: "run-1", deploymentSessionId: "session-1",
  releaseSha: SHA, expiresAt: "2026-09-21T16:00:00.000Z",
};

describe("the bearer is derived, not stored", () => {
  it("is the same for the same binding, in any process", () => {
    // Determinism is what makes the handoff work: prepare derives it, exits,
    // and certify derives the identical bearer from the row.
    expect(deriveCertificationNonce(testSecret(), binding)).toBe(deriveCertificationNonce(testSecret(), binding));
  });

  it("changes with every field of the binding", () => {
    const base = deriveCertificationNonce(testSecret(), binding);
    for (const over of [{ capabilityId: "cap-2" }, { runId: "run-2" }, { deploymentSessionId: "session-2" },
      { releaseSha: "b".repeat(40) }, { expiresAt: "2026-09-21T17:00:00.000Z" }]) {
      expect(deriveCertificationNonce(testSecret(), { ...binding, ...over })).not.toBe(base);
    }
  });

  it("cannot be produced by a different key", () => {
    const other = parseCapabilityKey("v1:another-capability-key-not-a-real-secret-x");
    expect(deriveCertificationNonce(other, binding)).not.toBe(deriveCertificationNonce(testSecret(), binding));
  });

  it("separates the binding's fields rather than running them together", () => {
    // Joining them directly would let a run id ending where a session id begins
    // produce one string for two bindings - two capabilities with one bearer.
    const left = deriveCertificationNonce(testSecret(), { ...binding, runId: "ab", deploymentSessionId: "c" });
    const right = deriveCertificationNonce(testSecret(), { ...binding, runId: "a", deploymentSessionId: "bc" });
    expect(left).not.toBe(right);
  });

  it("carries the key's version, so a rotation is a different key and not a reinterpretation", () => {
    expect(deriveCertificationNonce(testSecret(), binding).startsWith("v1.")).toBe(true);
    const rotated = parseCapabilityKey("v2:another-capability-key-not-a-real-secret-x");
    expect(deriveCertificationNonce(rotated, binding).startsWith("v2.")).toBe(true);
  });

  it("refuses a key that is not one", () => {
    for (const bad of [undefined, "", "no-version", "v1:short", ":key-that-is-long-enough-to-be-a-key-00"]) {
      expect(() => parseCapabilityKey(bad)).toThrow("CERTIFICATION_CAPABILITY_KEY_INVALID");
    }
  });
});

describe("what the database is left holding", () => {
  const launch = () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    new SqliteCertificationRunStore(db).create({
      runId: "run", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt: now.toISOString(),
    });
    db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
        pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
      VALUES ('session', 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'DEPLOYING', 'OLD_LINEAGE_ALLOWED',
        '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
        ?, '2099-01-01T00:00:00.000Z', 1)`).run(SHA, SHA, now.toISOString());
    return db;
  };

  it("stores a digest and never the bearer", () => {
    // A read-only leak of this database must not become a capability to pass
    // the deployment fence and buy behind it.
    const db = launch();
    const { capability, nonce } = issueCapability(new SqliteCertificationCapabilityStore(db),
      { runId: "run", deploymentSessionId: "session", releaseSha: SHA, maxAmountKopecks: 100, ttlMs: 300_000 }, now, testSecret());

    const stored = db.prepare("SELECT nonce FROM certification_capabilities WHERE id = ?").get(capability.id) as { nonce: string };
    expect(stored.nonce).toBe(certificationNonceDigest(nonce));
    expect(stored.nonce).not.toBe(nonce);
    // Nothing in the row is the bearer, or any part of it.
    const row = JSON.stringify(db.prepare("SELECT * FROM certification_capabilities WHERE id = ?").get(capability.id));
    expect(row).not.toContain(nonce);
    expect(row).not.toContain(nonce.slice(8));
  });

  it("verifies a presented bearer without holding what makes one", () => {
    // The runtime being certified hashes what it was given and compares. It
    // never needs the key, so a target container cannot mint a claim.
    const digest = certificationNonceDigest(deriveCertificationNonce(testSecret(), binding));
    expect(nonceDigestMatches(digest, deriveCertificationNonce(testSecret(), binding))).toBe(true);
    expect(nonceDigestMatches(digest, "not-the-bearer")).toBe(false);
    expect(nonceDigestMatches(digest, "")).toBe(false);
  });

  it("keeps the key out of the runtime's own configuration", () => {
    // The commerce runtime verifies; only the runner derives.
    const runtime = ["commerce/src/api.ts", "commerce/src/certification/service-router.ts", "commerce/src/certification/catalogue-endpoint.ts"];
    for (const path of runtime) {
      expect(readFileSync(path, "utf8")).not.toContain("CAPABILITY_KEY");
    }
  });

  it("is the key the test fixtures use, spelled out rather than generated", () => {
    expect(TEST_CAPABILITY_KEY.startsWith("v1:")).toBe(true);
  });
});
