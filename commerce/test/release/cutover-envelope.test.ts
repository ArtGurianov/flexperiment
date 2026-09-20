import { describe, expect, it } from "vitest";
import { createCutoverEnvelope, InMemoryCutoverEnvelopeStore } from "../../src/release/cutover-envelope";

const target = "a".repeat(40);
const topology = { frontend: "b".repeat(40), admin: "b".repeat(40), commerce: "b".repeat(40), worker: "b".repeat(40) } as const;
const predecessorDatabase = { ref: "prelaunch-2026-09-20.sqlite", sha256: "c".repeat(64) };
const envelopeInput = {
  cutoverId: "cutover", adoptionNonce: "nonce", targetSha: target, mode: "MAINTENANCE_CUTOVER" as const,
  preDeployTopology: topology, predecessorDatabase,
  createdAt: "2026-09-19T00:00:00.000Z", expiresAt: "2026-09-19T00:05:00.000Z",
};

describe("cutover envelope", () => {
  it("identifies the predecessor archive by content, not only by name", () => {
    // A ref alone proves we know what the file is called. Restoring the wrong
    // snapshot under the right name is exactly the failure the digest excludes.
    expect(createCutoverEnvelope(envelopeInput).predecessorDatabase).toEqual(predecessorDatabase);
    expect(() => createCutoverEnvelope({ ...envelopeInput, predecessorDatabase: { ref: "  ", sha256: "c".repeat(64) } }))
      .toThrow("CUTOVER_ENVELOPE_PREDECESSOR_REF_INVALID");
    expect(() => createCutoverEnvelope({ ...envelopeInput, predecessorDatabase: { ref: "archive.sqlite", sha256: "not-a-digest" } }))
      .toThrow("CUTOVER_ENVELOPE_PREDECESSOR_DIGEST_INVALID");
  });

  it("refuses a malformed pre-deploy topology before an envelope can be stored", () => {
    expect(() => createCutoverEnvelope({ ...envelopeInput, preDeployTopology: { ...topology, worker: "not-a-sha" } }))
      .toThrow("CUTOVER_ENVELOPE_TOPOLOGY_INVALID");
  });

  it("offers no validate-and-consume call at all", () => {
    // Consumption has to follow the successor's database commit. A store that
    // could do both at once would let a caller consume the envelope first and
    // lose the handoff entirely if the commit then failed.
    const store = new InMemoryCutoverEnvelopeStore();
    store.write(createCutoverEnvelope(envelopeInput));
    expect(store.isConsumed("cutover")).toBe(false);
    store.markConsumed("cutover");
    expect(store.isConsumed("cutover")).toBe(true);
    expect("consume" in store).toBe(false);
  });
});
