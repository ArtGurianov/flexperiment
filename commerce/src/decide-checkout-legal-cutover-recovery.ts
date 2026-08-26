import { readFileSync } from "node:fs";
import { checkoutLegalCutoverRecovery } from "./checkout-legal-cutover-recovery";
import type { ReleaseControlStatus } from "./release-control";

const [statusPath, releaseId, candidateSourceCommit, candidateLegalVersion, previousLegalVersion, activeLegalVersion, repairSourceCommit] = process.argv.slice(2);
if (!statusPath || !releaseId || !candidateSourceCommit || !candidateLegalVersion || !previousLegalVersion || !activeLegalVersion) throw new Error("Pass status JSON, release id, candidate source commit, candidate and previous legal versions, active legal version, and optional repair source commit.");
const status = JSON.parse(readFileSync(statusPath, "utf8")) as ReleaseControlStatus;
console.log(JSON.stringify(checkoutLegalCutoverRecovery({ status, releaseId, candidateSourceCommit, candidateLegalVersion, previousLegalVersion, activeLegalVersion, repairSourceCommit })));
