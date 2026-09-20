import { describe, expect, it } from "vitest";
import { createCutoverEnvelope, InMemoryCutoverEnvelopeStore } from "../../src/release/cutover-envelope";
import { adoptCutover } from "../../src/release/cutover-handoff";
import { DeploySessions, InMemoryReleaseAuthorityStore } from "../../src/release/deploy-session";

const target = "a".repeat(40);
const old = "b".repeat(40);
const topology = (sha: string) => ({ frontend: sha, admin: sha, commerce: sha, worker: sha });
const predecessorDatabase = { ref: "prelaunch-2026-09-20.sqlite", sha256: "c".repeat(64) };
const now = new Date("2026-09-20T00:01:00.000Z");

const envelope = (overrides: Partial<Parameters<typeof createCutoverEnvelope>[0]> = {}) =>
  createCutoverEnvelope({
    cutoverId: "cutover-1", adoptionNonce: "nonce-1", targetSha: target, mode: "MAINTENANCE_CUTOVER",
    preDeployTopology: topology(old), predecessorDatabase,
    createdAt: "2026-09-20T00:00:00.000Z", expiresAt: "2026-09-20T00:05:00.000Z",
    ...overrides,
  });

const successor = () => {
  const store = new InMemoryReleaseAuthorityStore();
  const envelopes = new InMemoryCutoverEnvelopeStore();
  return { store, envelopes, sessions: new DeploySessions(store, () => now) };
};

const context = { ownerId: "owner", sourceCommit: target, schemaLineage: "SUPPORTED" as const, adoptionNonce: "nonce-1", now };

describe("cutover handoff across the lineage boundary", () => {
  it("adopts into the database first and only then consumes the envelope", () => {
    const { store, envelopes, sessions } = successor();
    envelopes.write(envelope());

    const result = adoptCutover(sessions, store, envelopes, "cutover-1", context);

    expect(result.reconciled).toBe(false);
    expect(result.session).toMatchObject({
      state: "FENCED", adoptedCutoverId: "cutover-1",
      predecessorDatabaseRef: predecessorDatabase.ref, predecessorDatabaseSha256: predecessorDatabase.sha256,
    });
    // The successor owns the gate from the instant it adopts: sales are shut on
    // the new lineage before anything else is allowed to happen on it.
    expect(store.deploymentGate()).toEqual({ closed: true, deploymentSessionId: result.session.id });
    expect(envelopes.isConsumed("cutover-1")).toBe(true);
  });

  it("finishes the handoff when the runner died between the commit and consumption", () => {
    const { store, envelopes, sessions } = successor();
    envelopes.write(envelope());
    const first = adoptCutover(sessions, store, envelopes, "cutover-1", context);

    // Reproduce the crash: the database committed, the filesystem half did not.
    const unconsumed = new InMemoryCutoverEnvelopeStore();
    unconsumed.write(envelope());

    const retry = adoptCutover(sessions, store, unconsumed, "cutover-1", context);

    expect(retry.reconciled).toBe(true);
    expect(retry.session.id).toBe(first.session.id);
    expect(unconsumed.isConsumed("cutover-1")).toBe(true);
    // No second session, and the gate is still the first one's.
    expect(store.deploymentGate().deploymentSessionId).toBe(first.session.id);
  });

  it("does not let expiry undo an adoption that already committed", () => {
    const { store, envelopes, sessions } = successor();
    envelopes.write(envelope());
    const first = adoptCutover(sessions, store, envelopes, "cutover-1", context);

    const unconsumed = new InMemoryCutoverEnvelopeStore();
    unconsumed.write(envelope());
    // The runner came back an hour late. The handoff still happened in time,
    // and refusing now would strand the filesystem half forever.
    const late = { ...context, now: new Date("2026-09-20T01:00:00.000Z") };

    const retry = adoptCutover(sessions, store, unconsumed, "cutover-1", late);
    expect(retry).toMatchObject({ reconciled: true, session: { id: first.session.id } });
    expect(unconsumed.isConsumed("cutover-1")).toBe(true);
  });

  it("refuses a leftover envelope that is a different handoff wearing the same id", () => {
    const { store, envelopes, sessions } = successor();
    envelopes.write(envelope());
    adoptCutover(sessions, store, envelopes, "cutover-1", context);

    // Same cutover id, different predecessor archive. Which one is authoritative
    // is not a question automated recovery may answer by guessing.
    const impostor = new InMemoryCutoverEnvelopeStore();
    impostor.write(envelope({ predecessorDatabase: { ...predecessorDatabase, sha256: "d".repeat(64) } }));

    expect(() => adoptCutover(sessions, store, impostor, "cutover-1", context))
      .toThrow("CUTOVER_ADOPTION_IDENTITY_MISMATCH: predecessorDatabase.sha256");
  });

  it("refuses a first adoption on an expired envelope or an unsupported lineage", () => {
    const { store, envelopes, sessions } = successor();
    envelopes.write(envelope());

    expect(() => adoptCutover(sessions, store, envelopes, "cutover-1", { ...context, now: new Date("2026-09-20T01:00:00.000Z") }))
      .toThrow("CUTOVER_ENVELOPE_EXPIRED");
    expect(() => adoptCutover(sessions, store, envelopes, "cutover-1", { ...context, schemaLineage: "LEGACY" }))
      .toThrow("CUTOVER_ENVELOPE_LINEAGE_NOT_SUPPORTED");
    // Nothing was adopted and nothing was consumed by either refusal.
    expect(store.deploymentGate().closed).toBe(false);
    expect(envelopes.isConsumed("cutover-1")).toBe(false);
  });

  it("refuses an envelope that was never written", () => {
    const { store, envelopes, sessions } = successor();
    expect(() => adoptCutover(sessions, store, envelopes, "cutover-1", context)).toThrow("CUTOVER_ENVELOPE_NOT_FOUND");
  });
});
