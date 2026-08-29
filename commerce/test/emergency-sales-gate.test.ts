import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import { ReleaseSalesGate } from "../src/release-control";
import { releaseStateHash, type GenerationHead } from "../src/release-generation";
import { concurrencyFixture, type ConcurrencyFixture } from "./support/concurrency-fixture";

const fixtures: ConcurrencyFixture[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()?.close(); });

const SOURCE = "a".repeat(40);
const legalBaseline = {
  legal_version: "2026-08-26.1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
};

const candidateHead = (releaseId: string): GenerationHead => ({
  release_id: releaseId, candidate_generation: 1, source_commit: SOURCE,
  migration_inventory: { files: { "0031_participant_age_band.sql": "1".repeat(64) } },
  legal_baseline: legalBaseline, release_family: "test-family",
  checkout_contract_version: "test-v1", admin_contract_version: "test-v1",
  phase: "PAUSED", phase_sequence: 0,
});

function setup() {
  const fixture = concurrencyFixture(); fixtures.push(fixture);
  return { fixture, domain: new CommerceDomain(fixture.primary, new MockProvider()) };
}

const emergencyOn = (db: ConcurrencyFixture["primary"]) =>
  db.prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1").run();
const emergencyOff = (db: ConcurrencyFixture["primary"]) =>
  db.prepare("UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1 WHERE singleton = 1").run();

const pauseRelease = (db: ConcurrencyFixture["primary"]) => {
  const releaseId = `emergency-test:${randomUUID()}`;
  new ReleaseSalesGate(db).acquireCandidate({ head: candidateHead(releaseId) });
  return releaseId;
};

const ordersOpen = (domain: CommerceDomain) => {
  try { domain.assertNewOrdersOpen(); return true; } catch { return false; }
};

/**
 * Every row asserts through CommerceDomain.assertNewOrdersOpen - the public
 * composition boundary customers actually hit. ReleaseSalesGate's own check
 * knows nothing about the emergency gate, so proving that half would prove
 * nothing about whether sales are really open.
 */
describe("emergency gate composed with the release gate", () => {
  it("opens only when both gates are open", () => {
    const { fixture, domain } = setup();
    expect(ordersOpen(domain)).toBe(true);

    emergencyOn(fixture.primary);
    expect(ordersOpen(domain)).toBe(false);

    emergencyOff(fixture.primary);
    expect(ordersOpen(domain)).toBe(true);
  });

  it("stays closed while a release holds the gate, whatever the emergency gate does", () => {
    const { fixture, domain } = setup();
    pauseRelease(fixture.primary);
    expect(ordersOpen(domain)).toBe(false);

    emergencyOn(fixture.primary);
    expect(ordersOpen(domain)).toBe(false);

    // Clearing the emergency stop must not reopen a release-held gate.
    emergencyOff(fixture.primary);
    expect(ordersOpen(domain)).toBe(false);
  });

  it("stays closed when the release reopens while the emergency stop is latched", () => {
    const { fixture, domain } = setup();
    const releaseId = pauseRelease(fixture.primary);
    emergencyOn(fixture.primary);

    const gate = new ReleaseSalesGate(fixture.primary);
    const head = gate.abortCandidate(
      { release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(candidateHead(releaseId)), reason: "abandoned" },
      () => ({ source_commit: SOURCE, migration_versions: ["0031_participant_age_band.sql"] } as never),
    ).head;
    expect(head.phase).toBe("ABORTED");

    // Release authority is clear, emergency authority is not.
    expect(ordersOpen(domain)).toBe(false);
    emergencyOff(fixture.primary);
    expect(ordersOpen(domain)).toBe(true);
  });

  it("survives a process restart: the stop is durable, not in-process state", () => {
    const { fixture, domain } = setup();
    emergencyOn(fixture.primary);
    expect(ordersOpen(domain)).toBe(false);

    const reopened = fixture.restart();
    const afterRestart = new CommerceDomain(reopened, new MockProvider());
    expect(ordersOpen(afterRestart)).toBe(false);
    expect(reopened.prepare("SELECT sales_paused, revision FROM emergency_sales_gate WHERE singleton = 1").get()).toEqual({ sales_paused: 1, revision: 2 });
  });

  it("is observed identically by a second connection, with no per-connection caching", () => {
    const { fixture, domain } = setup();
    const other = fixture.connect();
    const otherDomain = new CommerceDomain(other, new MockProvider());

    expect(ordersOpen(domain)).toBe(true);
    expect(ordersOpen(otherDomain)).toBe(true);

    // Latched on one connection, immediately enforced on the other.
    emergencyOn(other);
    expect(ordersOpen(domain)).toBe(false);
    expect(ordersOpen(otherDomain)).toBe(false);
  });

  it("lets exactly one of two competing revision-CAS writers win", () => {
    const { fixture } = setup();
    const a = fixture.primary;
    const b = fixture.connect();
    const before = a.prepare("SELECT revision FROM emergency_sales_gate WHERE singleton = 1").get() as { revision: number };

    // Both read the same revision, both attempt the same compare-and-set.
    const cas = (db: ConcurrencyFixture["primary"]) => db
      .prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1 AND revision = ?")
      .run(before.revision).changes;

    const first = cas(a);
    const second = cas(b);
    expect([first, second].sort()).toEqual([0, 1]);
    expect(a.prepare("SELECT revision FROM emergency_sales_gate WHERE singleton = 1").get()).toEqual({ revision: before.revision + 1 });
  });
});
