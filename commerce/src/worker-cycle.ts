import type { CommerceDomain } from "./domain";
import { runWorkerSweep, type WorkerSweepDomain } from "./worker-sweep";
import { runAgentReferralsWorkerSweep } from "./agent-referrals-worker-sweep";
import type Database from "better-sqlite3";

type WorkerCycleDomain = WorkerSweepDomain & Pick<CommerceDomain, "collectProviderDrift">;

/**
 * A rejected recovery task or due provider-drift probe aborts this cycle before
 * it returns a success result to the worker.
 */
export const runWorkerCycle = async (input: {
  domain: WorkerCycleDomain;
  db: Database.Database;
  collectProviderDrift: boolean;
}) => {
  const cityInterest = await runWorkerSweep(input.domain);
  if (input.collectProviderDrift) await input.domain.collectProviderDrift();
  const agentReferrals = runAgentReferralsWorkerSweep(input.db);
  return { ...cityInterest, agent_referrals: agentReferrals };
};
