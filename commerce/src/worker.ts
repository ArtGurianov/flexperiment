import { openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { emailProviderFromEnvironment } from "./email-provider";
import { providerFromEnvironment } from "./provider";
import { runWorkerSweep } from "./worker-sweep";

const sqlite = openDatabase();
const domain = new CommerceDomain(sqlite, providerFromEnvironment(), emailProviderFromEnvironment());
let nextDriftSweepAt = 0;
let sweeping = false;

const sweep = async () => {
  const cityInterest = await runWorkerSweep(domain);
  if (cityInterest.expired_deleted || cityInterest.intents_created) {
    console.log(`Commerce city-interest lifecycle expired_deleted=${cityInterest.expired_deleted} intents_created=${cityInterest.intents_created}`);
  }
  if (Date.now() >= nextDriftSweepAt) {
    nextDriftSweepAt = Date.now() + 24 * 60 * 60_000;
    await domain.collectProviderDrift();
  }
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
