import { openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { emailProviderFromEnvironment } from "./email-provider";
import { providerFromEnvironment } from "./provider";
import { runWorkerCycle } from "./worker-cycle";
import { recordRuntimeHeartbeatEvidence, recordRuntimeStartupEvidence } from "./runtime-release-evidence";

const sqlite = openDatabase();
const domain = new CommerceDomain(sqlite, providerFromEnvironment(), emailProviderFromEnvironment());
const sourceCommit = process.env.SOURCE_COMMIT?.trim() || "UNAVAILABLE";
// Do not advertise readiness until the worker's required dependencies have
// initialized. Liveness is deliberately distinct from successful work.
const recordReadyHeartbeat = () => recordRuntimeHeartbeatEvidence(sqlite, "WORKER", sourceCommit);
recordRuntimeStartupEvidence(sqlite, "WORKER", sourceCommit);
let nextDriftSweepAt = 0;
let sweeping = false;

const sweep = async () => {
  const driftDue = Date.now() >= nextDriftSweepAt;
  const cityInterest = await runWorkerCycle({ domain, db: sqlite, sourceCommit, collectProviderDrift: driftDue });
  if (cityInterest.expired_deleted || cityInterest.intents_created) {
    console.log(`Commerce city-interest lifecycle expired_deleted=${cityInterest.expired_deleted} intents_created=${cityInterest.intents_created}`);
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
setInterval(recordReadyHeartbeat, 30_000);
console.log("Commerce recovery worker running.");
