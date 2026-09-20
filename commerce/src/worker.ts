import { assertSupportedDatabase, openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { emailProviderFromEnvironment } from "./email-provider";
import { providerFromEnvironment } from "./provider";
import { runWorkerCycle } from "./worker-cycle";

const sqlite = openDatabase();
// The worker never migrates - the API owns that - but it must not trust a
// database whose lineage it has not checked.
assertSupportedDatabase(sqlite);
const domain = new CommerceDomain(sqlite, providerFromEnvironment(), emailProviderFromEnvironment());
let nextDriftSweepAt = 0;
let sweeping = false;

const sweep = async () => {
  const driftDue = Date.now() >= nextDriftSweepAt;
  const cityInterest = await runWorkerCycle({ domain, db: sqlite, collectProviderDrift: driftDue });
  if (cityInterest.expired_deleted || cityInterest.intents_created) {
    console.log(`Commerce city-interest lifecycle expired_deleted=${cityInterest.expired_deleted} intents_created=${cityInterest.intents_created}`);
  }
  const agentReferrals = cityInterest.agent_referrals;
  if (agentReferrals.removal_required_marked || agentReferrals.removal_overdue_marked || agentReferrals.payment_attempts_recovered) {
    console.log(`Agent Referrals worker sweep removal_required=${agentReferrals.removal_required_marked} removal_overdue=${agentReferrals.removal_overdue_marked} payment_attempts_recovered=${agentReferrals.payment_attempts_recovered}`);
  }
  const reviewQueueTotal = Object.values(agentReferrals.review_queue_totals).reduce((sum, count) => sum + count, 0);
  if (reviewQueueTotal > 0) {
    const breakdown = Object.entries(agentReferrals.review_queue_totals).filter(([, count]) => count > 0).map(([key, count]) => `${key}=${count}`).join(" ");
    console.log(`Agent Referrals review queue: ${reviewQueueTotal} item(s) awaiting operator review (${breakdown})`);
  }
  if (driftDue) nextDriftSweepAt = Date.now() + 24 * 60 * 60_000;
};

const runSweep = async () => {
  if (sweeping) return;
  sweeping = true;
  try { await sweep(); }
  catch (error) { console.error("Commerce worker sweep failed", error instanceof Error ? error.message : "unknown error"); }
  finally { sweeping = false; }
};

void runSweep();
setInterval(() => void runSweep(), 30_000);
console.log("Commerce recovery worker running.");
