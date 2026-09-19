import { randomUUID } from "node:crypto";
import type { DeployMode, PreDeployTopology } from "./deploy-session";
import { isSourceCommit } from "./runtime-identity";

export type CutoverEnvelope = {
  readonly cutoverId: string;
  readonly targetSha: string;
  readonly mode: DeployMode;
  readonly preDeployTopology: PreDeployTopology;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly adoptionNonce: string;
};

export type CutoverAdoption = {
  readonly sourceCommit: string;
  readonly schemaLineage: "SUPPORTED" | "EMPTY_BOOTSTRAPPABLE" | "LEGACY" | "UNKNOWN";
  readonly deploySessionExists: boolean;
  readonly adoptionNonce: string;
  readonly now: Date;
};

export const createCutoverEnvelope = (input: Omit<CutoverEnvelope, "cutoverId" | "adoptionNonce"> & Partial<Pick<CutoverEnvelope, "cutoverId" | "adoptionNonce">>): CutoverEnvelope => {
  if (input.mode !== "MAINTENANCE_CUTOVER") throw new Error("CUTOVER_ENVELOPE_MODE_INVALID");
  if (!isSourceCommit(input.targetSha)) throw new Error("CUTOVER_ENVELOPE_TARGET_SHA_INVALID");
  const surfaces = ["frontend", "admin", "commerce", "worker"] as const;
  if (Object.keys(input.preDeployTopology).length !== surfaces.length || surfaces.some((surface) => !isSourceCommit(input.preDeployTopology[surface]))) {
    throw new Error("CUTOVER_ENVELOPE_TOPOLOGY_INVALID");
  }
  if (!(Date.parse(input.createdAt) < Date.parse(input.expiresAt))) throw new Error("CUTOVER_ENVELOPE_EXPIRY_INVALID");
  return { ...input, cutoverId: input.cutoverId ?? randomUUID(), adoptionNonce: input.adoptionNonce ?? randomUUID() };
};

export const assessCutoverAdoption = (envelope: CutoverEnvelope, adoption: CutoverAdoption): string | undefined => {
  if (envelope.mode !== "MAINTENANCE_CUTOVER") return "CUTOVER_ENVELOPE_MODE_INVALID";
  if (Date.parse(envelope.expiresAt) <= adoption.now.getTime()) return "CUTOVER_ENVELOPE_EXPIRED";
  if (adoption.sourceCommit !== envelope.targetSha) return "CUTOVER_ENVELOPE_TARGET_MISMATCH";
  if (adoption.schemaLineage !== "SUPPORTED") return "CUTOVER_ENVELOPE_LINEAGE_NOT_SUPPORTED";
  if (adoption.deploySessionExists) return "CUTOVER_ENVELOPE_SESSION_ALREADY_EXISTS";
  if (adoption.adoptionNonce !== envelope.adoptionNonce) return "CUTOVER_ENVELOPE_NONCE_MISMATCH";
  return undefined;
};

/** Test-only storage. P9 supplies the atomic 0600 filesystem adapter on the shared persistent volume. */
export class InMemoryCutoverEnvelopeStore {
  #entries = new Map<string, { envelope: CutoverEnvelope; consumed: boolean }>();

  write(envelope: CutoverEnvelope): void {
    if (this.#entries.has(envelope.cutoverId)) throw new Error("CUTOVER_ENVELOPE_ALREADY_EXISTS");
    this.#entries.set(envelope.cutoverId, { envelope, consumed: false });
  }

  read(cutoverId: string): CutoverEnvelope | undefined { return this.#entries.get(cutoverId)?.envelope; }

  consume(cutoverId: string, adoption: CutoverAdoption): CutoverEnvelope {
    const entry = this.#entries.get(cutoverId);
    if (!entry) throw new Error("CUTOVER_ENVELOPE_NOT_FOUND");
    if (entry.consumed) throw new Error("CUTOVER_ENVELOPE_ALREADY_CONSUMED");
    const failure = assessCutoverAdoption(entry.envelope, adoption);
    if (failure) throw new Error(failure);
    entry.consumed = true;
    return entry.envelope;
  }
}
