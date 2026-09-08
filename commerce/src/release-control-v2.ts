import { createHash } from "node:crypto";

/**
 * Release Control v2, Phase 1.
 *
 * This module is deliberately a pure packet generator. It does not read Git,
 * the environment, a database, or the network; nor does it expose an executor.
 * A packet describes a possible future authority boundary but never grants one.
 */

export const RELEASE_PACKET_SCHEMA_VERSION = "release-control-v2-packet-v1" as const;
export type ReleasePolicyLane = "BENIGN" | "MIGRATION" | "LEGAL" | "FINANCIAL" | "ATTRIBUTION" | "RELEASE_CONTROL" | "SURFACE" | "COMPATIBILITY";
export type ReleasePacketDecision = "ADMIT_BENIGN_SHADOW" | "STOP_ESCALATE";

export type SealedReleaseIdentity = { sha: string; tree: string };
export type ReleasePacketInput = {
  readonly base: SealedReleaseIdentity;
  readonly candidate: SealedReleaseIdentity;
  readonly changed_paths: readonly string[];
  readonly activation_required: boolean;
};

export type ReleasePacket = {
  readonly schema_version: typeof RELEASE_PACKET_SCHEMA_VERSION;
  readonly mode: "SHADOW_ONLY";
  readonly production_authority: "NONE";
  readonly mutations: "FORBIDDEN";
  readonly release_id: string;
  readonly semantic_hash: string;
  readonly base_sha: string;
  readonly base_tree: string;
  readonly candidate_sha: string;
  readonly candidate_tree: string;
  readonly base: SealedReleaseIdentity;
  readonly candidate: SealedReleaseIdentity;
  readonly diff_manifest: readonly string[];
  readonly certificate: {
    readonly schema_version: "release-control-v2-certificate-v1";
    readonly base_sha: string;
    readonly base_tree: string;
    readonly candidate_sha: string;
    readonly candidate_tree: string;
    readonly diff_manifest_sha256: string;
  };
  readonly policy_lanes: readonly ReleasePolicyLane[];
  readonly risk_reasons: readonly string[];
  readonly decision: ReleasePacketDecision;
  readonly required_authority: "NONE" | "ESCALATION_REQUIRED";
  readonly expected_ref_transitions: readonly { readonly ref: "runtime-candidate" | "production-deploy"; readonly from: string; readonly to: string; readonly operation: "GUARDED_CAS" }[];
  readonly candidate_publication_ref: string;
  readonly expected_deploy_target: string | null;
  readonly expected_reconciliation_checks: readonly string[];
  readonly stop_conditions: readonly string[];
  readonly activation_required: boolean;
  readonly generated_workflows: readonly [];
  readonly historical_synthesis: false;
  readonly mutation_plan: null;
};

const SHA = /^[a-f0-9]{40}$/;
const laneOrder: readonly ReleasePolicyLane[] = ["MIGRATION", "LEGAL", "FINANCIAL", "ATTRIBUTION", "RELEASE_CONTROL", "SURFACE", "COMPATIBILITY", "BENIGN"];
const releaseControlPaths = new Set([
  "commerce/src/release-expectation.ts",
  "commerce/src/release-control.ts",
  "commerce/src/release-generation.ts",
  "commerce/src/sales-gate.ts",
  "commerce/src/release-control-schema.ts",
]);
const financialPaths = new Set([
  "commerce/src/promo-pricing.ts",
  "commerce/src/basis-points.ts",
  "commerce/src/reward-calculation.ts",
  "commerce/src/agent-referrals-partner-promo-pricing.ts",
  "commerce/src/agent-referrals-payment.ts",
  "commerce/src/agent-referrals-settlement.ts",
  "commerce/src/agent-referrals-reward-registry.ts",
]);
const attributionPaths = new Set([
  "commerce/src/agent-referrals-attribution.ts",
  "commerce/src/agent-referrals-settlement-step-up.ts",
]);
const compatibilityPaths = new Set([
  "commerce/src/crypto.ts",
  "commerce/src/certification-evidence.ts",
  "commerce/src/certification-dispatch.ts",
  "commerce/src/legal-manifest.ts",
  "commerce/src/legal-release.ts",
  "commerce/src/occurrence-notification-capability.ts",
  "commerce/src/utc-timestamp.ts",
]);

const inDirectory = (path: string, directory: string) => path.startsWith(`${directory}/`);
const assertIdentity = (label: string, identity: SealedReleaseIdentity) => {
  if (!SHA.test(identity.sha) || !SHA.test(identity.tree)) throw new Error(`RELEASE_PACKET_${label}_IDENTITY_INVALID`);
};

/** Conservative path classifier. Unknown paths remain BENIGN only when no known sensitive lane is crossed. */
export const classifyReleasePaths = (paths: readonly string[]): readonly ReleasePolicyLane[] => {
  const lanes = new Set<ReleasePolicyLane>();
  for (const path of paths) {
    if (inDirectory(path, "commerce/migrations")) lanes.add("MIGRATION");
    if (inDirectory(path, "commerce/legal") || inDirectory(path, "public/legal")) lanes.add("LEGAL");
    if (financialPaths.has(path)) lanes.add("FINANCIAL");
    if (attributionPaths.has(path)) lanes.add("ATTRIBUTION");
    if (releaseControlPaths.has(path)) lanes.add("RELEASE_CONTROL");
    if (path === "release-surface-contract.json") lanes.add("SURFACE");
    if (compatibilityPaths.has(path)) lanes.add("COMPATIBILITY");
    // A new release-prefixed runtime seam is intentionally not assumed benign
    // before the registry has reviewed it. It is a compatibility-shaped
    // unknown, so the packet escalates rather than silently widening BENIGN.
    if (path.startsWith("commerce/src/release-") && !releaseControlPaths.has(path) && !compatibilityPaths.has(path)) lanes.add("COMPATIBILITY");
  }
  return (lanes.size ? laneOrder.filter((lane) => lanes.has(lane)) : ["BENIGN"]);
};

const canonicalManifest = (paths: readonly string[]) => [...new Set(paths)].sort();
const reasonFor = (lane: ReleasePolicyLane) => `POLICY_LANE_${lane}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type UnsignedReleasePacket = Omit<ReleasePacket, "semantic_hash">;
const stableHash = (packet: UnsignedReleasePacket) => createHash("sha256").update(JSON.stringify(packet)).digest("hex");

export const buildReleasePacket = (input: ReleasePacketInput): ReleasePacket => {
  assertIdentity("BASE", input.base);
  assertIdentity("CANDIDATE", input.candidate);
  if (typeof input.activation_required !== "boolean") throw new Error("RELEASE_PACKET_ACTIVATION_REQUIRED_INVALID");
  if (input.changed_paths.some((path) => !path || path.includes("\0") || path.startsWith("/") || path.includes(".."))) {
    throw new Error("RELEASE_PACKET_DIFF_MANIFEST_INVALID");
  }

  const diff_manifest = canonicalManifest(input.changed_paths);
  const certificate = {
    schema_version: "release-control-v2-certificate-v1" as const,
    base_sha: input.base.sha,
    base_tree: input.base.tree,
    candidate_sha: input.candidate.sha,
    candidate_tree: input.candidate.tree,
    diff_manifest_sha256: sha256(JSON.stringify(diff_manifest)),
  };
  const policy_lanes = classifyReleasePaths(diff_manifest);
  const benign = policy_lanes.length === 1 && policy_lanes[0] === "BENIGN";
  const decision: ReleasePacketDecision = benign ? "ADMIT_BENIGN_SHADOW" : "STOP_ESCALATE";
  const expected_ref_transitions = [
    { ref: "runtime-candidate" as const, from: input.base.sha, to: input.candidate.sha, operation: "GUARDED_CAS" as const },
    { ref: "production-deploy" as const, from: input.base.sha, to: input.candidate.sha, operation: "GUARDED_CAS" as const },
  ];
  const candidate_publication_ref = `refs/heads/runtime/release-control-v2-${input.candidate.sha}`;

  const unsigned: UnsignedReleasePacket = {
    schema_version: RELEASE_PACKET_SCHEMA_VERSION,
    mode: "SHADOW_ONLY",
    production_authority: "NONE",
    mutations: "FORBIDDEN",
    release_id: `shadow-${input.candidate.sha}`,
    base_sha: input.base.sha,
    base_tree: input.base.tree,
    candidate_sha: input.candidate.sha,
    candidate_tree: input.candidate.tree,
    base: { ...input.base },
    candidate: { ...input.candidate },
    diff_manifest,
    certificate,
    policy_lanes,
    risk_reasons: policy_lanes.map(reasonFor),
    decision,
    required_authority: benign ? "NONE" : "ESCALATION_REQUIRED",
    expected_ref_transitions,
    candidate_publication_ref,
    expected_deploy_target: input.candidate.sha,
    expected_reconciliation_checks: ["EXACT_RUNTIME_CONVERGENCE", "EXACT_PROTECTED_REF_READBACK"],
    stop_conditions: benign
      ? []
      : ["SENSITIVE_POLICY_LANE", "PHASE_1_ESCALATION_REQUIRED", "NO_AUTONOMOUS_EXECUTION"],
    activation_required: input.activation_required,
    generated_workflows: [],
    historical_synthesis: false,
    mutation_plan: null,
  };
  return { ...unsigned, semantic_hash: stableHash(unsigned) };
};

/** Stable serialization makes a packet directly reviewable and hashable by a later, separate executor. */
export const canonicalReleasePacket = (packet: ReleasePacket): string => JSON.stringify(packet);

const packetKeys = new Set<keyof ReleasePacket>([
  "schema_version", "mode", "production_authority", "mutations", "release_id", "semantic_hash",
  "base_sha", "base_tree", "candidate_sha", "candidate_tree", "base", "candidate", "diff_manifest", "certificate",
  "policy_lanes", "risk_reasons", "decision", "required_authority", "expected_ref_transitions",
  "candidate_publication_ref", "expected_deploy_target", "expected_reconciliation_checks", "stop_conditions",
  "activation_required", "generated_workflows", "historical_synthesis", "mutation_plan",
]);

/** Strictly rehydrates a packet from untrusted transport JSON without granting it authority. */
export const validateReleasePacket = (value: unknown): ReleasePacket => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RELEASE_PACKET_INVALID");
  const packet = value as Record<string, unknown>;
  if (Object.keys(packet).length !== packetKeys.size || Object.keys(packet).some((key) => !packetKeys.has(key as keyof ReleasePacket))) {
    throw new Error("RELEASE_PACKET_SCHEMA_INVALID");
  }
  if (!packet.base || !packet.candidate || !Array.isArray(packet.diff_manifest)) throw new Error("RELEASE_PACKET_SCHEMA_INVALID");
  const base = packet.base as SealedReleaseIdentity;
  const candidate = packet.candidate as SealedReleaseIdentity;
  const rebuilt = buildReleasePacket({
    base,
    candidate,
    changed_paths: packet.diff_manifest as string[],
    activation_required: packet.activation_required as boolean,
  });
  if (packet.semantic_hash !== rebuilt.semantic_hash) throw new Error("RELEASE_PACKET_HASH_MISMATCH");
  if (canonicalReleasePacket(value as ReleasePacket) !== canonicalReleasePacket(rebuilt)) throw new Error("RELEASE_PACKET_SEMANTICS_MISMATCH");
  return rebuilt;
};
