import type { CommerceDomain } from "./domain";
import { recordSuccessfulWorkerSweep } from "./runtime-release-evidence";
import { runWorkerSweep, type WorkerSweepDomain } from "./worker-sweep";
import { runAgentReferralsWorkerSweep } from "./agent-referrals-worker-sweep";
import type Database from "better-sqlite3";

type WorkerCycleDomain = WorkerSweepDomain & Pick<CommerceDomain, "collectProviderDrift">;

/**
 * Completion evidence is deliberately the final operation. A rejected recovery
 * task or due provider-drift probe leaves the previous sweep evidence untouched.
 */
export const runWorkerCycle = async (input: {
  domain: WorkerCycleDomain;
  db: Database.Database;
  sourceCommit: string;
  collectProviderDrift: boolean;
}) => {
  const cityInterest = await runWorkerSweep(input.domain);
  if (input.collectProviderDrift) await input.domain.collectProviderDrift();
  const agentReferrals = runAgentReferralsWorkerSweep(input.db);
  recordSuccessfulWorkerSweep(input.db, input.sourceCommit);
  return { ...cityInterest, agent_referrals: agentReferrals };
};
