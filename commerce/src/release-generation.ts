import { canonicalV2, sha256 } from "./crypto";

export const releasePhases = ["PAUSED", "DEPLOYED_READ_ONLY", "CERTIFICATION_ONLY", "CERTIFICATION_IN_FLIGHT", "CERTIFIED", "COMPLETE", "RECOVERY_REQUIRED"] as const;
export type ReleasePhase = (typeof releasePhases)[number];
export type MigrationInventory = { files: Record<string, string> };
export type CertificationLeaseStatus = "ACTIVE" | "CONSUMED" | "EXPIRED" | "REVOKED";
export type CertificationBinding = { lease_id: string; occurrence_id: string; promo_id: string; expected_idempotency_key_hash: string; lease_expires_at: string; status: CertificationLeaseStatus };
export type GenerationHead = { release_id: string; candidate_generation: number; source_commit: string; migration_inventory: MigrationInventory; legal_baseline: unknown; release_family: string; checkout_contract_version: string; admin_contract_version: string; phase: ReleasePhase; phase_sequence: number; certification?: CertificationBinding };
export type V2Event = { seq: number; release_id: string; action: "ACQUIRED" | "PAUSED" | "REOPENED"; details_json: string };
type Envelope = { schema_version: 2; kind: "CANDIDATE_ACQUIRED" | "CANDIDATE_SUPERSEDED" | "PHASE_CHANGED" | "RUNTIME_READINESS_DEFECT" | "PUBLIC_FRONTEND_DEFECT"; [key: string]: unknown };

const phases = new Set<string>(releasePhases);
const permittedPhaseChanges: Readonly<Record<Exclude<ReleasePhase, "COMPLETE">, readonly ReleasePhase[]>> = {
  PAUSED: ["DEPLOYED_READ_ONLY", "RECOVERY_REQUIRED"],
  DEPLOYED_READ_ONLY: ["CERTIFICATION_ONLY", "RECOVERY_REQUIRED"],
  CERTIFICATION_ONLY: ["CERTIFICATION_IN_FLIGHT", "DEPLOYED_READ_ONLY", "RECOVERY_REQUIRED"],
  CERTIFICATION_IN_FLIGHT: ["CERTIFIED", "DEPLOYED_READ_ONLY", "RECOVERY_REQUIRED"],
  CERTIFIED: ["COMPLETE", "RECOVERY_REQUIRED"],
  RECOVERY_REQUIRED: [],
};
const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sameCertificationScope = (left: CertificationBinding, right: CertificationBinding) =>
  left.lease_id === right.lease_id && left.occurrence_id === right.occurrence_id && left.promo_id === right.promo_id
  && left.expected_idempotency_key_hash === right.expected_idempotency_key_hash && left.lease_expires_at === right.lease_expires_at;
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const exactNumber = (value: unknown, expected: number) => typeof value === "number" && value === expected;
export const parseCertificationEvidence = (value: unknown, binding: CertificationBinding): boolean => {
  const evidence = asRecord(value);
  return Boolean(evidence
    && evidence.occurrence_id === binding.occurrence_id
    && evidence.promo_id === binding.promo_id
    && ["order_id", "payment_id", "refund_id"].every((key) => nonEmptyString(evidence[key]))
    && exactNumber(evidence.price_kopecks, 101) && exactNumber(evidence.discount_kopecks, 1)
    && exactNumber(evidence.amount_kopecks, 100) && exactNumber(evidence.captured_kopecks, 100)
    && exactNumber(evidence.refunded_kopecks, 100));
};
export const parseCertificationRetryEvidence = (value: unknown): boolean => {
  const evidence = asRecord(value);
  if (!evidence || evidence.reason !== "OPERATIONAL" || !nonEmptyString(evidence.order_id) || !nonEmptyString(evidence.payment_id) || !nonEmptyString(evidence.payment_state) || !nonEmptyString(evidence.payment_status)) return false;
  return evidence.payment_status === "EXPIRED" || (evidence.payment_status === "CANCELLED" && evidence.payment_state === "CREATE_FAILED");
};
const certificationDefectReasons = new Set(["CERTIFICATION_ORDER_MISMATCH", "CERTIFICATION_SCOPE_MISMATCH", "CERTIFICATION_FIXTURE_EVIDENCE_MISMATCH", "CERTIFICATION_AMOUNT_EVIDENCE_INVALID", "CERTIFICATION_CAPTURE_REFUND_INCOMPLETE", "CERTIFICATION_ORDER_NOT_FOUND", "CERTIFICATION_REFUND_EVIDENCE_AMBIGUOUS"]);
export const parseCertificationDefectEvidence = (value: unknown): boolean => {
  const evidence = asRecord(value);
  return Boolean(evidence && typeof evidence.reason === "string" && certificationDefectReasons.has(evidence.reason) && nonEmptyString(evidence.order_id));
};
export const runtimeReadinessErrorClasses = ["TLS_CERT_CHAIN_UNTRUSTED", "PROVIDER_BAD_REQUEST", "PROVIDER_NETWORK", "PROVIDER_RESPONSE_INVALID"] as const;
export type RuntimeReadinessErrorClass = (typeof runtimeReadinessErrorClasses)[number];
export type RuntimeReadinessDefectEvidence = {
  reason: "RUNTIME_READINESS_DEFECT";
  readiness_component: "PROVIDER_READINESS";
  error_class: RuntimeReadinessErrorClass;
  error_code: string;
  source_commit: string;
};
const runtimeReadinessErrorClassSet = new Set<string>(runtimeReadinessErrorClasses);
export const parseRuntimeReadinessDefectEvidence = (value: unknown, sourceCommit: string): value is RuntimeReadinessDefectEvidence => {
  const evidence = asRecord(value);
  if (!evidence || Object.keys(evidence).length !== 5) return false;
  return evidence.reason === "RUNTIME_READINESS_DEFECT"
    && evidence.readiness_component === "PROVIDER_READINESS"
    && typeof evidence.error_class === "string" && runtimeReadinessErrorClassSet.has(evidence.error_class)
    && typeof evidence.error_code === "string" && /^[A-Z0-9_]{1,80}$/.test(evidence.error_code)
    && evidence.source_commit === sourceCommit;
};
export const publicFrontendDefectErrorClasses = ["STATIC_ROUTING"] as const;
export type PublicFrontendDefectErrorClass = (typeof publicFrontendDefectErrorClasses)[number];
export type PublicFrontendDefectEvidence = {
  reason: "PUBLIC_FRONTEND_DEFECT";
  component: "PUBLIC_FRONTEND";
  error_class: PublicFrontendDefectErrorClass;
  error_code: string;
  probe_path: string;
  http_status: number;
  observed_frontend_source_commit: string;
  source_commit: string;
};
const publicFrontendDefectErrorClassSet = new Set<string>(publicFrontendDefectErrorClasses);
export const parsePublicFrontendDefectEvidence = (value: unknown, sourceCommit: string): value is PublicFrontendDefectEvidence => {
  const evidence = asRecord(value);
  if (!evidence || Object.keys(evidence).length !== 8) return false;
  return evidence.reason === "PUBLIC_FRONTEND_DEFECT"
    && evidence.component === "PUBLIC_FRONTEND"
    && typeof evidence.error_class === "string" && publicFrontendDefectErrorClassSet.has(evidence.error_class)
    && typeof evidence.error_code === "string" && /^[A-Z0-9_]{1,80}$/.test(evidence.error_code)
    && typeof evidence.probe_path === "string" && /^\/[!-~]*$/.test(evidence.probe_path)
    && typeof evidence.http_status === "number" && Number.isInteger(evidence.http_status) && evidence.http_status >= 100 && evidence.http_status <= 599
    && typeof evidence.observed_frontend_source_commit === "string" && /^[a-f0-9]{40}$/.test(evidence.observed_frontend_source_commit)
    && evidence.source_commit === sourceCommit;
};
const headFrom = (value: unknown): GenerationHead | undefined => {
  const input = asRecord(value);
  if (!input || typeof input.release_id !== "string" || !Number.isInteger(input.candidate_generation) || typeof input.source_commit !== "string" || typeof input.phase !== "string" || !phases.has(input.phase) || !Number.isInteger(input.phase_sequence)) return undefined;
  const inventory = asRecord(input.migration_inventory); const files = inventory && asRecord(inventory.files);
  if (!files || Object.values(files).some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return undefined;
  for (const key of ["release_family", "checkout_contract_version", "admin_contract_version"] as const) if (typeof input[key] !== "string") return undefined;
  const certification = input.certification === undefined ? undefined : asRecord(input.certification);
  if (certification && (["lease_id", "occurrence_id", "promo_id", "expected_idempotency_key_hash", "lease_expires_at"].some((key) => typeof certification[key] !== "string") || !["ACTIVE", "CONSUMED", "EXPIRED", "REVOKED"].includes(String(certification.status)))) return undefined;
  return input as unknown as GenerationHead;
};

export function replayReleaseGenerationChain(events: readonly V2Event[]): { head?: GenerationHead; corrupt?: string } {
  let current: GenerationHead | undefined;
  const consumedFixtures: Array<Pick<CertificationBinding, "occurrence_id" | "promo_id">> = [];
  const hasConsumedFixture = (binding: Pick<CertificationBinding, "occurrence_id" | "promo_id">) => consumedFixtures.some((fixture) => fixture.occurrence_id === binding.occurrence_id || fixture.promo_id === binding.promo_id);
  const rememberConsumedFixture = (binding: Pick<CertificationBinding, "occurrence_id" | "promo_id">) => {
    if (!consumedFixtures.some((fixture) => fixture.occurrence_id === binding.occurrence_id && fixture.promo_id === binding.promo_id)) consumedFixtures.push(binding);
  };
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    let envelope: Envelope;
    try { envelope = JSON.parse(event.details_json) as Envelope; } catch { continue; }
    if (envelope.schema_version !== 2) continue;
    if (!current && envelope.kind !== "CANDIDATE_ACQUIRED") return { corrupt: "V2_CHAIN_MUST_START_WITH_ACQUIRE" };
    if (envelope.kind === "CANDIDATE_ACQUIRED") {
      const next = headFrom(envelope.head);
      if (!next || current || next.certification || next.release_id !== event.release_id || next.candidate_generation !== 1 || next.phase !== "PAUSED" || next.phase_sequence !== 0 || event.action !== "ACQUIRED") return { corrupt: "INVALID_CANDIDATE_ACQUIRED" };
      current = next;
      continue;
    }
    if (!current) return { corrupt: "MISSING_CURRENT_HEAD" };
    if (event.release_id !== current.release_id) return { corrupt: "V2_EVENT_RELEASE_ID_MISMATCH" };
    if (envelope.kind === "CANDIDATE_SUPERSEDED") {
      const next = headFrom(envelope.head);
      if (!next || next.certification || event.action !== "PAUSED" || envelope.from_generation !== current.candidate_generation || envelope.from_sha !== current.source_commit || next.release_id !== current.release_id || next.candidate_generation !== current.candidate_generation + 1 || next.phase !== "PAUSED" || next.phase_sequence !== 0 || canonicalV2(next.legal_baseline) !== canonicalV2(current.legal_baseline) || next.release_family !== current.release_family || next.checkout_contract_version !== current.checkout_contract_version || next.admin_contract_version !== current.admin_contract_version) return { corrupt: "INVALID_CANDIDATE_SUPERSEDED" };
      if (current.certification?.status === "CONSUMED") rememberConsumedFixture(current.certification);
      current = next;
      continue;
    }
    if (envelope.kind !== "PHASE_CHANGED" && envelope.kind !== "RUNTIME_READINESS_DEFECT" && envelope.kind !== "PUBLIC_FRONTEND_DEFECT") return { corrupt: "UNKNOWN_V2_EVENT_KIND" };
    const next = headFrom(envelope.head);
    if (!next || current.phase === "COMPLETE" || next.release_id !== current.release_id || next.candidate_generation !== current.candidate_generation || next.source_commit !== current.source_commit || canonicalV2(next.migration_inventory) !== canonicalV2(current.migration_inventory) || canonicalV2(next.legal_baseline) !== canonicalV2(current.legal_baseline) || next.release_family !== current.release_family || next.checkout_contract_version !== current.checkout_contract_version || next.admin_contract_version !== current.admin_contract_version || envelope.from_phase !== current.phase || envelope.from_phase_sequence !== current.phase_sequence || next.phase_sequence !== current.phase_sequence + 1 || !permittedPhaseChanges[current.phase].includes(next.phase)) return { corrupt: "INVALID_PHASE_CHANGE" };
    const runtimeReadinessDefectTransition = current.phase === "PAUSED" && next.phase === "RECOVERY_REQUIRED";
    if (runtimeReadinessDefectTransition) {
      const unexpectedEvidence = ["certification_evidence", "certification_retry", "certification_defect", "public_frontend_defect"].some((key) => envelope[key] !== undefined);
      if (envelope.kind !== "RUNTIME_READINESS_DEFECT" || event.action !== "PAUSED" || current.certification || next.certification || unexpectedEvidence || !parseRuntimeReadinessDefectEvidence(envelope.runtime_readiness_defect, current.source_commit)) return { corrupt: "INVALID_RUNTIME_READINESS_DEFECT" };
      current = next;
      continue;
    }
    // A certified candidate can be recovered only through this specific,
    // evidence-owned edge: the financial certification binding must survive
    // byte-for-byte, since this recovers a public-surface defect discovered
    // after certification, not the certification itself.
    const publicFrontendDefectTransition = current.phase === "CERTIFIED" && next.phase === "RECOVERY_REQUIRED";
    if (publicFrontendDefectTransition) {
      const unexpectedEvidence = ["certification_evidence", "certification_retry", "certification_defect", "runtime_readiness_defect"].some((key) => envelope[key] !== undefined);
      if (envelope.kind !== "PUBLIC_FRONTEND_DEFECT" || event.action !== "PAUSED" || !current.certification || !next.certification || canonicalV2(next.certification) !== canonicalV2(current.certification) || unexpectedEvidence || !parsePublicFrontendDefectEvidence(envelope.public_frontend_defect, current.source_commit)) return { corrupt: "INVALID_PUBLIC_FRONTEND_DEFECT" };
      current = next;
      continue;
    }
    if (envelope.kind !== "PHASE_CHANGED") return { corrupt: "INVALID_RUNTIME_READINESS_DEFECT" };
    if (!current.certification && next.certification) {
      if (current.phase !== "DEPLOYED_READ_ONLY" || next.phase !== "CERTIFICATION_ONLY" || next.certification.status !== "ACTIVE" || hasConsumedFixture(next.certification)) return { corrupt: "INVALID_CERTIFICATION_BINDING" };
    } else if (current.certification) {
      const retriesAfterPriorAttempt = current.phase === "DEPLOYED_READ_ONLY" && next.phase === "CERTIFICATION_ONLY" && current.certification.status !== "ACTIVE" && next.certification?.status === "ACTIVE";
      const freshAfterConsumedAttempt = current.certification.status !== "CONSUMED" || (next.certification?.occurrence_id !== current.certification.occurrence_id && next.certification?.promo_id !== current.certification.promo_id);
      if (!next.certification || (retriesAfterPriorAttempt && (!freshAfterConsumedAttempt || hasConsumedFixture(next.certification))) || (!retriesAfterPriorAttempt && !sameCertificationScope(current.certification, next.certification))) return { corrupt: "CERTIFICATION_BINDING_MUTATED" };
      const validStatusTransition = retriesAfterPriorAttempt
        || (current.phase === "CERTIFICATION_ONLY" && next.phase === "CERTIFICATION_IN_FLIGHT" && current.certification.status === "ACTIVE" && next.certification.status === "CONSUMED")
        || (current.phase === "CERTIFICATION_IN_FLIGHT" && next.phase === "CERTIFIED" && current.certification.status === "CONSUMED" && next.certification.status === "CONSUMED" && parseCertificationEvidence(envelope.certification_evidence, current.certification))
        || (current.phase === "CERTIFICATION_ONLY" && ["DEPLOYED_READ_ONLY", "RECOVERY_REQUIRED"].includes(next.phase) && current.certification.status === "ACTIVE" && next.certification.status === "REVOKED")
        || (current.phase === "CERTIFICATION_IN_FLIGHT" && next.phase === "DEPLOYED_READ_ONLY" && current.certification.status === "CONSUMED" && next.certification.status === "CONSUMED" && parseCertificationRetryEvidence(envelope.certification_retry))
        || (current.phase === "CERTIFICATION_IN_FLIGHT" && next.phase === "RECOVERY_REQUIRED" && current.certification.status === "CONSUMED" && next.certification.status === "CONSUMED" && parseCertificationDefectEvidence(envelope.certification_defect))
        || (current.phase === "DEPLOYED_READ_ONLY" && next.phase === "RECOVERY_REQUIRED" && ["CONSUMED", "REVOKED"].includes(current.certification.status) && next.certification.status === current.certification.status)
        // CERTIFIED -> RECOVERY_REQUIRED is handled exclusively by
        // publicFrontendDefectTransition above; it is unreachable here.
        || (current.phase === "CERTIFIED" && next.phase === "COMPLETE" && current.certification.status === "CONSUMED" && next.certification.status === "CONSUMED");
      if (!validStatusTransition) return { corrupt: "INVALID_CERTIFICATION_STATUS_TRANSITION" };
    }
    if (event.action === "PAUSED" && next.phase === "COMPLETE") return { corrupt: "COMPLETE_MUST_REOPEN" };
    if (event.action === "REOPENED" && next.phase !== "COMPLETE") return { corrupt: "REOPENED_NON_COMPLETE" };
    if (next.certification?.status === "CONSUMED") rememberConsumedFixture(next.certification);
    current = next;
  }
  return current ? { head: current } : {};
}

export function reconcileHeadWithProjection(head: GenerationHead, projection: { owner_release_id: string | null; sales_paused: boolean; expected_source_commit?: string | null; expected_migration?: string | null; expected_legal_version?: string | null; expected_legal_manifest_sha256?: string | null }): string | undefined {
  if (head.phase === "COMPLETE") return projection.owner_release_id === null && !projection.sales_paused ? undefined : "RELEASE_STATE_CORRUPT";
  if (projection.owner_release_id !== head.release_id || !projection.sales_paused) return "RELEASE_STATE_CORRUPT";
  if (projection.expected_source_commit !== undefined && projection.expected_source_commit !== head.source_commit) return "RELEASE_STATE_CORRUPT";
  if (projection.expected_migration !== undefined && projection.expected_migration !== candidateExpectedMigration(head)) return "RELEASE_STATE_CORRUPT";
  const baseline = head.legal_baseline as { legal_version?: unknown; legal_manifest_sha256?: unknown };
  if (typeof baseline?.legal_version !== "string" || typeof baseline.legal_manifest_sha256 !== "string") return "RELEASE_STATE_CORRUPT";
  if (projection.expected_legal_version !== undefined && projection.expected_legal_version !== baseline.legal_version) return "RELEASE_STATE_CORRUPT";
  if (projection.expected_legal_manifest_sha256 !== undefined && projection.expected_legal_manifest_sha256 !== baseline.legal_manifest_sha256) return "RELEASE_STATE_CORRUPT";
  return undefined;
}

export function candidateExpectedMigration(head: GenerationHead): string {
  const migrations = Object.keys(head.migration_inventory.files).sort();
  const migration = migrations.at(-1);
  if (!migration || !/^\d{4}_[a-z0-9_]+\.sql$/.test(migration)) throw new Error("INVALID_MIGRATION_INVENTORY");
  return migration;
}

export const releaseStateHash = (head: GenerationHead): string => sha256(canonicalV2({
  release_id: head.release_id, candidate_generation: head.candidate_generation, source_commit: head.source_commit,
  migration_inventory: head.migration_inventory, legal_baseline: head.legal_baseline, release_family: head.release_family,
  checkout_contract_version: head.checkout_contract_version, admin_contract_version: head.admin_contract_version,
  phase: head.phase, phase_sequence: head.phase_sequence, certification: head.certification,
}));

/** New manifests may append migrations, never change an applied name's bytes. */
export function assertAppliedMigrationPrefix(appliedNames: readonly string[], headManifest: MigrationInventory, newManifest: MigrationInventory): string | undefined {
  const current = Object.keys(headManifest.files).sort(); const applied = [...appliedNames].sort(); const next = Object.keys(newManifest.files).sort();
  if (applied.some((name, index) => current[index] !== name)) return "APPLIED_MIGRATION_LEDGER_NOT_PREFIX";
  for (const name of applied) if (!headManifest.files[name] || !newManifest.files[name] || newManifest.files[name] !== headManifest.files[name]) return "APPLIED_MIGRATION_HASH_CHANGED";
  if (applied.some((name, index) => next[index] !== name)) return "NEW_MIGRATION_MANIFEST_NOT_APPLIED_PREFIX";
  return undefined;
}
