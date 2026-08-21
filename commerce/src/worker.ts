import { openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { emailProviderFromEnvironment } from "./email-provider";
import { providerFromEnvironment } from "./provider";

const sqlite = openDatabase();
const domain = new CommerceDomain(sqlite, providerFromEnvironment(), emailProviderFromEnvironment());
let nextDriftSweepAt = 0;
let sweeping = false;

const sweep = async () => {
  domain.recoverStaleCommands();
  domain.createObligationRefunds();
  await domain.submitRequestedRefunds();
  await domain.reconcilePendingRefunds();
  await domain.processEmailOutbox();
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
