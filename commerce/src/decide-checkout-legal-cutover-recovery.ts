import { readFileSync } from "node:fs";
import { checkoutLegalCutoverRecovery } from "./checkout-legal-cutover-recovery";
import type { ReleaseControlStatus } from "./release-control";

const [statusPath, releaseId, candidateSourceCommit, candidateLegalVersion] = process.argv.slice(2);
if (!statusPath || !releaseId || !candidateSourceCommit || !candidateLegalVersion) throw new Error("Pass status JSON, release id, candidate source commit, and candidate legal version.");
const status = JSON.parse(readFileSync(statusPath, "utf8")) as ReleaseControlStatus;
console.log(JSON.stringify(checkoutLegalCutoverRecovery({ status, releaseId, candidateSourceCommit, candidateLegalVersion })));
