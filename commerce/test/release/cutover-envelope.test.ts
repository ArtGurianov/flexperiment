import { describe, expect, it } from "vitest";
import { createCutoverEnvelope, InMemoryCutoverEnvelopeStore } from "../../src/release/cutover-envelope";

const target = "a".repeat(40);
const topology = { frontend: "b".repeat(40), admin: "b".repeat(40), commerce: "b".repeat(40), worker: "b".repeat(40) } as const;

describe("cutover envelope", () => {
  it("can be adopted exactly once by the target launch lineage", () => {
    const envelope = createCutoverEnvelope({ cutoverId: "cutover", adoptionNonce: "nonce", targetSha: target, mode: "MAINTENANCE_CUTOVER", preDeployTopology: topology, createdAt: "2026-09-19T00:00:00.000Z", expiresAt: "2026-09-19T00:05:00.000Z" });
    const store = new InMemoryCutoverEnvelopeStore();
    store.write(envelope);
    const adoption = { sourceCommit: target, schemaLineage: "SUPPORTED" as const, deploySessionExists: false, adoptionNonce: "nonce", now: new Date("2026-09-19T00:01:00.000Z") };
    expect(store.consume("cutover", adoption)).toEqual(envelope);
    expect(() => store.consume("cutover", adoption)).toThrow("CUTOVER_ENVELOPE_ALREADY_CONSUMED");
  });

  it("refuses a target mismatch before consuming the envelope", () => {
    const envelope = createCutoverEnvelope({ cutoverId: "cutover", adoptionNonce: "nonce", targetSha: target, mode: "MAINTENANCE_CUTOVER", preDeployTopology: topology, createdAt: "2026-09-19T00:00:00.000Z", expiresAt: "2026-09-19T00:05:00.000Z" });
    const store = new InMemoryCutoverEnvelopeStore();
    store.write(envelope);
    expect(() => store.consume("cutover", { sourceCommit: "c".repeat(40), schemaLineage: "SUPPORTED", deploySessionExists: false, adoptionNonce: "nonce", now: new Date("2026-09-19T00:01:00.000Z") })).toThrow("CUTOVER_ENVELOPE_TARGET_MISMATCH");
  });

  it("refuses a malformed pre-deploy topology before an envelope can be stored", () => {
    expect(() => createCutoverEnvelope({ cutoverId: "cutover", adoptionNonce: "nonce", targetSha: target, mode: "MAINTENANCE_CUTOVER", preDeployTopology: { ...topology, worker: "not-a-sha" }, createdAt: "2026-09-19T00:00:00.000Z", expiresAt: "2026-09-19T00:05:00.000Z" })).toThrow("CUTOVER_ENVELOPE_TOPOLOGY_INVALID");
  });
});
