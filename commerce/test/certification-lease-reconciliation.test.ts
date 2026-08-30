import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { ReleaseSalesGate, type ReleaseRuntimeEvidence } from "../src/release-control";
import { releaseStateHash, type GenerationHead } from "../src/release-generation";

/**
 * Recovering an expired certification lease.
 *
 * Found in production during the 0041 cutover: `prepare` activated a 300-second
 * lease and the operator stopped to inspect the resulting state - exactly as the
 * runbook asks - and the window closed before the payment. Nothing was wrong
 * with the durable state, and no money had moved; the controller simply had no
 * branch that used a primitive the runtime already had.
 *
 * These tests pin that primitive end to end, because the controller's new branch
 * is only safe if the sequence underneath it really does revoke the old lease
 * and mint a usable new one for the SAME unconsumed fixture.
 */

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const SOURCE = "a".repeat(40);
const KEY_HASH = "b".repeat(64);

const MIGRATIONS = (() => {
  const db = openDatabase(":memory:"); migrate(db);
  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((r) => r.version);
  db.close();
  return Object.fromEntries(versions.map((v, i) => [v, String(i % 10).repeat(64)]));
})();

const legalBaseline = {
  legal_version: "2026-08-26.1", legal_manifest_sha256: "c".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "d".repeat(64), PRIVACY_POLICY: "e".repeat(64), PD_CONSENT: "f".repeat(64), CHECKOUT_DISCLOSURE: "0".repeat(64) },
};

const head = (releaseId: string): GenerationHead => ({
  release_id: releaseId, candidate_generation: 1, source_commit: SOURCE,
  migration_inventory: { files: MIGRATIONS }, legal_baseline: legalBaseline,
  release_family: "test-family", checkout_contract_version: "test-v1", admin_contract_version: "test-v1",
  phase: "PAUSED", phase_sequence: 0,
});

const evidence = (): ReleaseRuntimeEvidence => ({
  source_commit: SOURCE, migration_versions: Object.keys(MIGRATIONS), required_migrations: {},
  worker_source_commit: SOURCE, worker_started_at: null, worker_observed_at: null,
  worker_last_successful_sweep_at: null, legal_version: legalBaseline.legal_version,
  legal_manifest_sha256: legalBaseline.legal_manifest_sha256, legal_hashes: legalBaseline.legal_hashes,
  legal_publish_time: "2026-08-26T12:09:17Z", current_legal_copies_match: true,
  migration_source_hashes: MIGRATIONS,
} as ReleaseRuntimeEvidence);

/** The real fixture shape the lease validator insists on. */
const fixture = (db: ReturnType<typeof openDatabase>) => {
  const cityId = randomUUID(), occurrenceId = randomUUID(), promoId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)").run(cityId, `c-${cityId.slice(0, 8)}`, "Тест");
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      visibility, sales_status, fulfillment_status, venue_status, venue_disclosure_text, venue_announce_by)
    VALUES (?, ?, 'CERT', '2027-03-20T10:00:00.000Z', '2027-03-20T13:00:00.000Z', 'Europe/Moscow', 101, 1,
      'HIDDEN', 'CLOSED', 'SCHEDULED', 'TO_BE_ANNOUNCED', 'tba', '2027-03-19T10:00:00.000Z')`).run(occurrenceId, cityId);
  const code = `CERT101-${promoId.slice(0, 8).toUpperCase()}`;
  db.prepare("INSERT INTO promo_codes(id, code, normalized_code, discount_type, discount_value, status) VALUES (?, ?, ?, 'FIXED', 1, 'ACTIVE')")
    .run(promoId, code, code.toUpperCase());
  return { occurrenceId, promoId };
};

/** Drives a real candidate to CERTIFICATION_ONLY with a live lease. */
const leased = (leaseSeconds = 300) => {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const releaseId = `lease-test:${randomUUID()}`;
  const { occurrenceId, promoId } = fixture(db);
  gate.acquireCandidate({ head: head(releaseId) });
  let current: GenerationHead = head(releaseId);
  const deployed = gate.changeCandidatePhase({
    release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(current),
    from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY",
  });
  current = deployed.head as GenerationHead;
  const activated = gate.activateCertificationLease({
    release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(current),
    occurrence_id: occurrenceId, promo_id: promoId, expected_idempotency_key_hash: KEY_HASH, lease_seconds: leaseSeconds,
  });
  return { db, gate, releaseId, occurrenceId, promoId, current: activated.head as GenerationHead };
};

const allowlist = (db: ReturnType<typeof openDatabase>) =>
  db.prepare("SELECT lease_id, status FROM release_certification_allowlist ORDER BY rowid").all();

const resetToDeployed = (gate: ReleaseSalesGate, releaseId: string, current: GenerationHead) =>
  gate.changeCandidatePhase({
    release_id: releaseId, candidate_generation: current.candidate_generation,
    expected_state_hash: releaseStateHash(current), from_phase: "CERTIFICATION_ONLY",
    phase_sequence: current.phase_sequence, to_phase: "DEPLOYED_READ_ONLY",
  });

describe("expired certification lease reconciliation", () => {
  it("revokes the old lease and issues a fresh one for the same fixture", () => {
    // The whole sequence the controller now performs, proven against the real
    // state machine rather than against the workflow's description of it.
    const { db, gate, releaseId, occurrenceId, promoId, current } = leased();
    const first = current.certification!;
    expect(first.status).toBe("ACTIVE");

    const reset = resetToDeployed(gate, releaseId, current);
    expect(reset.head.phase).toBe("DEPLOYED_READ_ONLY");
    expect(reset.head.certification?.status).toBe("REVOKED");
    expect(allowlist(db)).toEqual([{ lease_id: first.lease_id, status: "REVOKED" }]);

    const refreshed = gate.activateCertificationLease({
      release_id: releaseId, candidate_generation: 1,
      expected_state_hash: releaseStateHash(reset.head as GenerationHead),
      occurrence_id: occurrenceId, promo_id: promoId,
      expected_idempotency_key_hash: KEY_HASH, lease_seconds: 300,
    });
    const second = refreshed.head.certification!;

    expect(refreshed.head.phase).toBe("CERTIFICATION_ONLY");
    expect(second.status).toBe("ACTIVE");
    // A NEW lease, not a revived one.
    expect(second.lease_id).not.toBe(first.lease_id);
    expect(Date.parse(second.lease_expires_at)).toBeGreaterThan(Date.parse(first.lease_expires_at));
    // Bound to the SAME fixture: it was never consumed, so nothing about the
    // certification's scope changes.
    expect(second.occurrence_id).toBe(first.occurrence_id);
    expect(second.promo_id).toBe(first.promo_id);
    expect(second.expected_idempotency_key_hash).toBe(first.expected_idempotency_key_hash);
    expect(allowlist(db)).toEqual([
      { lease_id: first.lease_id, status: "REVOKED" },
      { lease_id: second.lease_id, status: "ACTIVE" },
    ]);
  });

  it("refuses a second live lease without the reset", () => {
    // This is why the phase reset is required rather than optional: activation
    // alone cannot displace a lease that is still ACTIVE.
    const { gate, releaseId, occurrenceId, promoId, current } = leased();
    expect(() => gate.activateCertificationLease({
      release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(current),
      occurrence_id: occurrenceId, promo_id: promoId, expected_idempotency_key_hash: KEY_HASH, lease_seconds: 300,
    })).toThrow(/RELEASE_STATE_STALE|CERTIFICATION_LEASE_ALREADY_ACTIVE/);
  });

  it("keeps the reset idempotent against a lost response", () => {
    // The workflow re-reads the head after the reset. If its own response was
    // lost, the rerun observes DEPLOYED_READ_ONLY and issues exactly one fresh
    // lease - the second reset attempt must not silently succeed and consume
    // another phase step.
    const { gate, releaseId, current } = leased();
    const reset = resetToDeployed(gate, releaseId, current);
    expect(() => resetToDeployed(gate, releaseId, current)).toThrow("RELEASE_STATE_STALE");
    expect(reset.head.phase_sequence).toBe(current.phase_sequence + 1);
  });

  it("refuses a reset presenting a stale state hash", () => {
    // The CAS is what makes this safe to automate at all.
    const { gate, releaseId, current } = leased();
    expect(() => gate.changeCandidatePhase({
      release_id: releaseId, candidate_generation: 1, expected_state_hash: "0".repeat(64),
      from_phase: "CERTIFICATION_ONLY", phase_sequence: current.phase_sequence, to_phase: "DEPLOYED_READ_ONLY",
    })).toThrow("RELEASE_STATE_STALE");
  });

  it("still refuses to reuse a fixture once it has been consumed", () => {
    // The reset must not become a way around fresh-fixture enforcement. A
    // consumed fixture is spent money; only an unconsumed one may be re-leased,
    // which is exactly why this recovery is safe for the production state it
    // was written for and would not be safe after a payment.
    const { db, gate, releaseId, occurrenceId, promoId, current } = leased();
    const reset = resetToDeployed(gate, releaseId, current);
    // A prior consumed lease over the same fixture, as a completed
    // certification would leave behind.
    db.prepare(`INSERT INTO release_certification_allowlist(lease_id, owner_release_id, candidate_generation,
        expected_source_commit, occurrence_id, promo_id, expected_idempotency_key_hash, lease_expires_at, status)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'CONSUMED')`)
      .run(randomUUID(), releaseId, SOURCE, occurrenceId, promoId, KEY_HASH, "2026-08-30T09:00:00.000Z");

    expect(() => gate.activateCertificationLease({
      release_id: releaseId, candidate_generation: 1,
      expected_state_hash: releaseStateHash(reset.head as GenerationHead),
      occurrence_id: occurrenceId, promo_id: promoId, expected_idempotency_key_hash: KEY_HASH, lease_seconds: 300,
    })).toThrow("CERTIFICATION_FRESH_FIXTURE_REQUIRED");
  });

  it("fails closed when the head and the allowlist disagree", () => {
    // Discovered while writing the test above: if the durable allowlist row is
    // no longer ACTIVE while the head still says it is, the reset refuses
    // rather than moving the phase on a lease it could not revoke.
    const { db, gate, releaseId, current } = leased();
    db.prepare("UPDATE release_certification_allowlist SET status = 'CONSUMED' WHERE status = 'ACTIVE'").run();
    expect(() => resetToDeployed(gate, releaseId, current)).toThrow("RELEASE_STATE_STALE");
  });
});
