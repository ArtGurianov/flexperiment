import type Database from "better-sqlite3";
import { agentReferralsActivationEvidence } from "./agent-referrals-activation";
import {
  AGENT_REFERRALS_ACTIVATION_MANIFEST_KEY,
  AGENT_REFERRALS_ACTIVATION_MANIFEST_VERSION,
  type AgentReferralsActivationManifest,
} from "./agent-referrals-activation-readiness";
import {
  agentReferralsFeatureState,
  lastAgentReferralsFeatureStateEvent,
  type AgentReferralsFeatureStateRow,
} from "./agent-referrals-feature-state";

export type AgentReferralsFeatureStateEvent = {
  readonly id: string;
  readonly from_state: "DORMANT" | "ACTIVE" | "SUSPENDED";
  readonly to_state: "DORMANT" | "ACTIVE" | "SUSPENDED";
  readonly owner_id: string;
  readonly reason: string;
  readonly revision: number;
  readonly created_at: string;
};

export type AgentReferralsActivationReconciliationEvidence = {
  readonly feature_state: AgentReferralsFeatureStateRow;
  readonly last_feature_state_event: AgentReferralsFeatureStateEvent | null;
  readonly activation_manifest: AgentReferralsActivationManifest | null;
};

export class AgentReferralsActivationReconciliationError extends Error {
  constructor(readonly code: string) { super(code); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const state = (value: unknown): value is AgentReferralsFeatureStateEvent["from_state"] =>
  value === "DORMANT" || value === "ACTIVE" || value === "SUSPENDED";
const string = (value: unknown): value is string => typeof value === "string";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const exactManifest = (value: unknown): AgentReferralsActivationManifest | null => {
  if (value === undefined) return null;
  if (!isRecord(value)
    || value.version !== AGENT_REFERRALS_ACTIVATION_MANIFEST_VERSION
    || !string(value.activation_id)
    || !string(value.terminal_release_id)
    || !string(value.source_commit)
    || !string(value.migration)
    || !string(value.legal_version)
    || !string(value.legal_manifest_sha256)
    || !string(value.otp_pepper_sha256)
    || value.otp_delivery_provider !== "unisender-go"
    || Object.keys(value).length !== 9) {
    throw new AgentReferralsActivationReconciliationError("AGENT_REFERRALS_ACTIVATION_MANIFEST_MALFORMED");
  }
  return value as AgentReferralsActivationManifest;
};

const exactEvent = (value: Record<string, unknown> | null): AgentReferralsFeatureStateEvent | null => {
  if (value === null) return null;
  if (!string(value.id)
    || !state(value.from_state)
    || !state(value.to_state)
    || !string(value.owner_id)
    || !string(value.reason)
    || !integer(value.revision)
    || !string(value.created_at)) {
    throw new AgentReferralsActivationReconciliationError("AGENT_REFERRALS_FEATURE_EVENT_MALFORMED");
  }
  return {
    id: value.id,
    from_state: value.from_state,
    to_state: value.to_state,
    owner_id: value.owner_id,
    reason: value.reason,
    revision: value.revision,
    created_at: value.created_at,
  };
};

/**
 * Read-only reconciliation evidence for the Q4 activation command.  The
 * feature row, its latest immutable event, and Q4's sealed activation
 * manifest are read under one deferred SQLite transaction, so a controller
 * cannot assemble an ACTIVE state from one instant with a manifest from
 * another.  This function has no transition, insert, or update path.
 */
export const agentReferralsActivationReconciliationEvidence = (db: Database.Database): AgentReferralsActivationReconciliationEvidence =>
  db.transaction(() => ({
    feature_state: agentReferralsFeatureState(db),
    last_feature_state_event: exactEvent(lastAgentReferralsFeatureStateEvent(db)),
    activation_manifest: exactManifest(agentReferralsActivationEvidence(db, AGENT_REFERRALS_ACTIVATION_MANIFEST_KEY)),
  })).deferred();
