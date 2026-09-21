export const SOURCE_COMMIT = /^[a-f0-9]{40}$/;

export type RuntimeUnit = "COMMERCE" | "WORKER";

export type RuntimeEvidence = {
  readonly sourceCommit: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly lastSuccessfulSweepAt?: string | null;
};

export type RuntimeEvidenceCode =
  | "SOURCE_COMMIT_INVALID"
  | "SOURCE_COMMIT_MISMATCH"
  | "STARTED_AT_INVALID"
  | "HEARTBEAT_INVALID"
  | "HEARTBEAT_STALE"
  | "SWEEP_MISSING"
  | "SWEEP_INVALID"
  | "SWEEP_STALE";

export const isSourceCommit = (value: unknown): value is string =>
  typeof value === "string" && SOURCE_COMMIT.test(value);

const timestamp = (value: string): number | undefined => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const isFreshTimestamp = (value: string, now: Date, maximumAgeMs: number): boolean => {
  const observed = timestamp(value);
  return observed !== undefined && observed <= now.getTime() && now.getTime() - observed <= maximumAgeMs;
};

/**
 * Validate evidence without storing it. `runtime_instance_evidence` exists in
 * the schema, but nothing writes it yet, so a caller supplies the row it read.
 */
export const validateRuntimeEvidence = (
  evidence: RuntimeEvidence,
  expectedCommit: string,
  options: { now: Date; heartbeatMaximumAgeMs: number; requireWorkerSweep?: boolean; sweepMaximumAgeMs?: number },
): RuntimeEvidenceCode | undefined => {
  if (!isSourceCommit(expectedCommit) || !isSourceCommit(evidence.sourceCommit)) return "SOURCE_COMMIT_INVALID";
  if (evidence.sourceCommit !== expectedCommit) return "SOURCE_COMMIT_MISMATCH";
  if (timestamp(evidence.startedAt) === undefined) return "STARTED_AT_INVALID";
  if (timestamp(evidence.heartbeatAt) === undefined) return "HEARTBEAT_INVALID";
  if (!isFreshTimestamp(evidence.heartbeatAt, options.now, options.heartbeatMaximumAgeMs)) return "HEARTBEAT_STALE";
  if (!options.requireWorkerSweep) return undefined;
  if (!evidence.lastSuccessfulSweepAt) return "SWEEP_MISSING";
  if (timestamp(evidence.lastSuccessfulSweepAt) === undefined) return "SWEEP_INVALID";
  if (!isFreshTimestamp(evidence.lastSuccessfulSweepAt, options.now, options.sweepMaximumAgeMs ?? options.heartbeatMaximumAgeMs)) {
    return "SWEEP_STALE";
  }
  return undefined;
};
