import { matchesSchemaInventory, parseInventoryExpectation } from "./expectation";
import { isSourceCommit, type RuntimeEvidence, validateRuntimeEvidence } from "./runtime-identity";
import type { SchemaLineage } from "./schema-identity";

export type ReleaseReadinessExpectation = {
  readonly sourceCommit: string;
  readonly schemaInventory: string;
  readonly legalVersion: string;
  readonly legalManifestSha256: string;
};

export type ReleaseReadinessEvidence = {
  readonly commerce?: RuntimeEvidence;
  readonly worker?: RuntimeEvidence;
  readonly schema: { readonly lineage: SchemaLineage; readonly versions: readonly string[] };
  readonly legal?: { readonly version: string; readonly manifestSha256: string };
};

export type ReadinessResult =
  | { readonly state: "ADMITTED" }
  | { readonly state: "PENDING"; readonly code: string }
  | { readonly state: "REJECTED"; readonly code: string };

export const evaluateReadiness = (
  expectation: ReleaseReadinessExpectation,
  evidence: ReleaseReadinessEvidence,
  now: Date,
  maximumAgeMs = 5 * 60_000,
): ReadinessResult => {
  if (!isSourceCommit(expectation.sourceCommit)) return { state: "REJECTED", code: "EXPECTED_SOURCE_COMMIT_INVALID" };
  if (!parseInventoryExpectation(expectation.schemaInventory)) return { state: "REJECTED", code: "EXPECTED_SCHEMA_INVENTORY_INVALID" };
  if (!/^[a-f0-9]{64}$/.test(expectation.legalManifestSha256)) return { state: "REJECTED", code: "EXPECTED_LEGAL_MANIFEST_SHA256_INVALID" };
  if (!evidence.commerce) return { state: "PENDING", code: "COMMERCE_RUNTIME_EVIDENCE_MISSING" };
  const commerce = validateRuntimeEvidence(evidence.commerce, expectation.sourceCommit, { now, heartbeatMaximumAgeMs: maximumAgeMs });
  if (commerce) return { state: "PENDING", code: `COMMERCE_${commerce}` };
  if (!evidence.worker) return { state: "PENDING", code: "WORKER_RUNTIME_EVIDENCE_MISSING" };
  const worker = validateRuntimeEvidence(evidence.worker, expectation.sourceCommit, { now, heartbeatMaximumAgeMs: maximumAgeMs, requireWorkerSweep: true });
  if (worker) return { state: "PENDING", code: `WORKER_${worker}` };
  if (evidence.schema.lineage === "LEGACY") return { state: "REJECTED", code: "LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED" };
  if (evidence.schema.lineage === "UNKNOWN") return { state: "REJECTED", code: "UNKNOWN_SCHEMA_LINEAGE" };
  if (evidence.schema.lineage === "EMPTY_BOOTSTRAPPABLE") return { state: "PENDING", code: "SCHEMA_NOT_BOOTSTRAPPED" };
  if (!matchesSchemaInventory(expectation.schemaInventory, evidence.schema.versions)) return { state: "PENDING", code: "SCHEMA_INVENTORY_NOT_CONVERGED" };
  if (!evidence.legal) return { state: "PENDING", code: "LEGAL_RELEASE_EVIDENCE_MISSING" };
  if (evidence.legal.version !== expectation.legalVersion) return { state: "PENDING", code: "LEGAL_RELEASE_VERSION_NOT_CONVERGED" };
  if (evidence.legal.manifestSha256 !== expectation.legalManifestSha256) return { state: "PENDING", code: "LEGAL_RELEASE_MANIFEST_NOT_CONVERGED" };
  return { state: "ADMITTED" };
};
