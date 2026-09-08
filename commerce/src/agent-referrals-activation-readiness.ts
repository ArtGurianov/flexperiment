import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  agentReferralsActivationEvidence,
  canonicalAgentReferralsActivationJson,
  recordAgentReferralsActivationEvidenceInTransaction,
} from "./agent-referrals-activation";
import { activateAgentReferralsInTransaction, agentReferralsFeatureState, type AgentReferralsFeatureStateRow } from "./agent-referrals-feature-state";
import { agentReferralsDormantReadinessEvidence, type AgentReferralsDormantReadinessEvidence } from "./agent-referrals-dormant-readiness";
import { ReleaseControlError, ReleaseSalesGate, type ReleaseExpectations, type ReleaseRuntimeEvidence } from "./release-control";
import type { OtpDeliveryCapability } from "./agent-referrals-otp";

/**
 * This is intentionally a single, closed manifest entry rather than a
 * caller-defined set of keys.  It records only non-secret identities and a
 * fingerprint of the OTP pepper; the pepper itself never enters SQLite,
 * response JSON, or a workflow log.
 */
export const AGENT_REFERRALS_ACTIVATION_MANIFEST_KEY = "agent-referrals-activation-v1";
export const AGENT_REFERRALS_ACTIVATION_MANIFEST_VERSION = "agent-referrals-activation-v1";
export const AGENT_REFERRALS_Q2_RELEASE_ID = "agent-referrals-f540b997d6d31a22293909ded7ce464c3f51732f";
export const AGENT_REFERRALS_Q2_SOURCE_COMMIT = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
export const AGENT_REFERRALS_Q3_SOURCE_COMMIT = "f317c836635bfe3a86735ecda6a050c51d4dc924";

export type AgentReferralsActivationRequest = {
  readonly activation_id: string;
  readonly terminal_release_id: string;
  readonly expected_feature_revision: number;
  readonly expected: ReleaseExpectations;
};

export type AgentReferralsActivationManifest = {
  readonly version: typeof AGENT_REFERRALS_ACTIVATION_MANIFEST_VERSION;
  readonly activation_id: string;
  readonly terminal_release_id: string;
  readonly source_commit: string;
  readonly migration: string;
  readonly legal_version: string;
  readonly legal_manifest_sha256: string;
  readonly otp_pepper_sha256: string;
  readonly otp_delivery_provider: "unisender-go";
};

export class AgentReferralsActivationReadinessError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const exactActivationId = (source: string) => `agent-referrals-activation-${source}`;
const exactTerminalReleaseId = (source: string) => `agent-referrals-q4-dormant-${source}`;

const activationManifest = (input: AgentReferralsActivationRequest, otpDelivery: OtpDeliveryCapability): AgentReferralsActivationManifest => {
  const pepper = process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER;
  if (!pepper) throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_OTP_PEPPER_MISSING", 503);
  if (!otpDelivery.configured || otpDelivery.provider_id !== "unisender-go") {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_OTP_DELIVERY_UNAVAILABLE", 503);
  }
  return {
    version: AGENT_REFERRALS_ACTIVATION_MANIFEST_VERSION,
    activation_id: input.activation_id,
    terminal_release_id: input.terminal_release_id,
    source_commit: input.expected.source_commit,
    migration: input.expected.migration,
    legal_version: input.expected.legal_version,
    legal_manifest_sha256: input.expected.legal_manifest_sha256,
    otp_pepper_sha256: createHash("sha256").update(pepper).digest("hex"),
    otp_delivery_provider: otpDelivery.provider_id,
  };
};

const assertRequestIdentity = (input: AgentReferralsActivationRequest): void => {
  if (!Number.isSafeInteger(input.expected_feature_revision) || input.expected_feature_revision < 0) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_REVISION_INVALID", 422);
  }
  if (!/^[a-f0-9]{40}$/.test(input.expected.source_commit)) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_SOURCE_INVALID", 422);
  }
  if (input.activation_id !== exactActivationId(input.expected.source_commit)) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_OWNER_INVALID", 409);
  }
  if (input.terminal_release_id !== exactTerminalReleaseId(input.expected.source_commit)) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_TERMINAL_RELEASE_INVALID", 409);
  }
};

const exactExpected = (actual: ReleaseExpectations | null, expected: ReleaseExpectations): boolean =>
  actual !== null && canonicalAgentReferralsActivationJson(actual) === canonicalAgentReferralsActivationJson(expected);

const assertGateAndRecovery = (gate: ReleaseSalesGate, input: AgentReferralsActivationRequest): void => {
  const status = gate.status();
  if (status.owner_release_id !== null) throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_RELEASE_OWNER_PRESENT", 409);
  if (status.sales_paused) throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_SALES_PAUSED", 409);

  const terminal = gate.completion(input.terminal_release_id);
  if (!terminal.complete || !exactExpected(terminal.expected, input.expected)) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_TERMINAL_RELEASE_UNPROVEN", 409);
  }

  const q2 = gate.resolution(AGENT_REFERRALS_Q2_RELEASE_ID);
  if (q2.complete || q2.resolution !== "SUPERSEDED" || q2.reason_code !== "SURFACE_CONTRACT_UNAVAILABLE"
    || q2.replacement_source_commit !== AGENT_REFERRALS_Q3_SOURCE_COMMIT) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_RECOVERY_HISTORY_UNPROVEN", 409);
  }
};

const readinessWithoutFeatureState = (evidence: AgentReferralsDormantReadinessEvidence): boolean =>
  evidence.reasons.every((reason) => reason === "FEATURE_STATE_NOT_DORMANT:ACTIVE");

const assertReadiness = (
  db: Database.Database,
  runtime: ReleaseRuntimeEvidence,
  gate: ReleaseSalesGate,
  input: AgentReferralsActivationRequest,
  current: AgentReferralsFeatureStateRow,
): AgentReferralsDormantReadinessEvidence => {
  const evidence = agentReferralsDormantReadinessEvidence(db, runtime, input.expected);
  const replay = current.state === "ACTIVE" && current.owner_id === input.activation_id;
  if (replay ? !readinessWithoutFeatureState(evidence) : !evidence.ready) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_DORMANT_READINESS_FAILED", 409, evidence.reasons.join(","));
  }
  assertGateAndRecovery(gate, input);
  return evidence;
};

const assertManifest = (db: Database.Database, manifest: AgentReferralsActivationManifest): void => {
  const actual = agentReferralsActivationEvidence(db, AGENT_REFERRALS_ACTIVATION_MANIFEST_KEY);
  if (actual !== undefined && canonicalAgentReferralsActivationJson(actual) !== canonicalAgentReferralsActivationJson(manifest)) {
    throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_MANIFEST_MISMATCH", 409);
  }
};

export type AgentReferralsActivationResult = {
  readonly feature_state: AgentReferralsFeatureStateRow;
  readonly readiness: AgentReferralsDormantReadinessEvidence;
  readonly manifest: AgentReferralsActivationManifest;
  readonly replayed: boolean;
};

/**
 * The sole DORMANT -> ACTIVE authority.  Every live fact is re-read under the
 * same BEGIN IMMEDIATE transaction as the feature-state CAS and immutable
 * manifest/audit writes; a readiness failure cannot leave a partial ACTIVE
 * state or an activation manifest/event behind.
 */
export const activateAgentReferralsIfReady = (
  db: Database.Database,
  runtimeReader: () => ReleaseRuntimeEvidence,
  gate: ReleaseSalesGate,
  otpDeliveryReader: () => OtpDeliveryCapability,
  input: AgentReferralsActivationRequest,
): AgentReferralsActivationResult => {
  assertRequestIdentity(input);
  try {
    return db.transaction(() => {
      // These runtime values are deliberately read only after BEGIN IMMEDIATE,
      // not by a controller/domain caller before entering this authority.
      const runtime = runtimeReader();
      const otpDelivery = otpDeliveryReader();
      const current = agentReferralsFeatureState(db);
      if (current.state === "ACTIVE" && current.owner_id !== input.activation_id) {
        throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_FEATURE_OWNER_CONFLICT", 409);
      }
      if (current.state === "ACTIVE" && current.owner_id === input.activation_id
        && current.revision !== input.expected_feature_revision + 1) {
        throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT", 409);
      }
      if (current.state !== "DORMANT" && !(current.state === "ACTIVE" && current.owner_id === input.activation_id)) {
        throw new AgentReferralsActivationReadinessError("AGENT_REFERRALS_ACTIVATION_STATE_NOT_DORMANT", 409);
      }

      const readiness = assertReadiness(db, runtime, gate, input, current);
      const manifest = activationManifest(input, otpDelivery);
      assertManifest(db, manifest);
      recordAgentReferralsActivationEvidenceInTransaction(db, AGENT_REFERRALS_ACTIVATION_MANIFEST_KEY, manifest);

      if (current.state === "ACTIVE") return { feature_state: current, readiness, manifest, replayed: true };
      const featureState = activateAgentReferralsInTransaction(db, {
        expected_revision: input.expected_feature_revision,
        owner_id: input.activation_id,
        reason: "AGENT_REFERRALS_ACTIVATION_V1",
      });
      return { feature_state: featureState, readiness, manifest, replayed: false };
    }).immediate();
  } catch (error) {
    if (error instanceof ReleaseControlError) throw new AgentReferralsActivationReadinessError(error.code, error.status);
    throw error;
  }
};
