import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { issueCapability } from "../../src/certification/capability";
import {
  certificationNonceDigest, deriveCertificationNonce, nonceDigestMatches, parseCapabilityKey,
  parseCapabilityKeyring, recoverCertificationNonce,
} from "../../src/certification/nonce";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import { testKeyring, testSecret, TEST_CAPABILITY_KEY, TEST_CAPABILITY_KEY_V2 } from "../support/certification-secret";

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
    const other = parseCapabilityKey(TEST_CAPABILITY_KEY_V2.replace("v2:", "v1:"));
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
    const rotated = parseCapabilityKey(TEST_CAPABILITY_KEY_V2);
    expect(deriveCertificationNonce(rotated, binding).startsWith("v2.")).toBe(true);
  });

  it("refuses a key that is not one", () => {
    for (const bad of [undefined, "", "no-version", ":anything", "v1:not+base64url/"]) {
      expect(() => parseCapabilityKey(bad)).toThrow("CERTIFICATION_CAPABILITY_KEY_INVALID");
    }
    // Length in characters is not entropy. Thirty-two readable characters
    // decode to twenty-four bytes, and this is the only thing standing between
    // a database reader and a claim.
    expect(() => parseCapabilityKey("v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
      .toThrow("at least 32 random bytes");
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

describe("rotating the key without stranding a run", () => {
  it("recovers a bearer issued under an older version", () => {
    // A key cannot be retired while a non-terminal run issued under it still
    // exists: that run's bearer is derivable only from the key that made it.
    const old = parseCapabilityKey(TEST_CAPABILITY_KEY);
    const nonce = deriveCertificationNonce(old, binding);
    const digest = certificationNonceDigest(nonce);

    expect(recoverCertificationNonce(testKeyring(), binding, digest)).toBe(nonce);
  });

  it("issues under the newest and still answers for the oldest", () => {
    const ring = testKeyring();
    expect(ring[0].version).toBe("v2");
    const newest = deriveCertificationNonce(ring[0], binding);
    expect(recoverCertificationNonce(ring, binding, certificationNonceDigest(newest))).toBe(newest);
  });

  it("answers nothing once the issuing key is gone", () => {
    // Honest, and the caller turns it into a refusal before anything is armed
    // rather than into a guess.
    const stranded = certificationNonceDigest(deriveCertificationNonce(parseCapabilityKey("v9:" + TEST_CAPABILITY_KEY_V2.slice(3)), binding));
    expect(recoverCertificationNonce(testKeyring(), binding, stranded)).toBeUndefined();
  });

  it("refuses a ring with two keys claiming one version", () => {
    expect(() => parseCapabilityKeyring(`${TEST_CAPABILITY_KEY} ${TEST_CAPABILITY_KEY}`))
      .toThrow("two keys share a version");
    expect(() => parseCapabilityKeyring("   ")).toThrow("no key configured");
  });
});
