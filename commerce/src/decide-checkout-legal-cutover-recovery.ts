import { readFileSync } from "node:fs";
import { checkoutLegalCutoverRecovery } from "./checkout-legal-cutover-recovery";
import type { ReleaseControlStatus } from "./release-control";

const [statusPath, releaseId, candidateSourceCommit, candidateLegalVersion, previousLegalVersion, activeLegalVersion, repairSourceCommit, currentLegalCopiesMatch] = process.argv.slice(2);
if (!statusPath || !releaseId || !candidateSourceCommit || !candidateLegalVersion || !previousLegalVersion || !activeLegalVersion || !currentLegalCopiesMatch) throw new Error("Pass status JSON, release id, candidate source commit, candidate and previous legal versions, active legal version, optional repair source commit, and current legal-copy match flag.");
const status = JSON.parse(readFileSync(statusPath, "utf8")) as ReleaseControlStatus;
if (!["true", "false"].includes(currentLegalCopiesMatch)) throw new Error("Current legal-copy match flag must be true or false.");
console.log(JSON.stringify(checkoutLegalCutoverRecovery({ status, releaseId, candidateSourceCommit, candidateLegalVersion, previousLegalVersion, activeLegalVersion, repairSourceCommit, currentLegalCopiesMatch: currentLegalCopiesMatch === "true" })));
