import { openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { emailProviderFromEnvironment } from "./email-provider";
import { providerFromEnvironment } from "./provider";

const sqlite = openDatabase();
const domain = new CommerceDomain(sqlite, providerFromEnvironment(), emailProviderFromEnvironment());
let nextDriftSweepAt = 0;

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
void sweep();
setInterval(() => void sweep(), 30_000).unref();
console.log("Commerce recovery worker running.");
