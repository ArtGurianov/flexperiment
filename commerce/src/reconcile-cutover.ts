import { readFileSync } from "node:fs";
import { reconcileCutover } from "./cutover-reconciliation";
import type { ReleaseCompletion, ReleaseControlRequest, ReleaseControlStatus, ReleaseRuntimeEvidence } from "./release-control";

const [statusPath, completionPath, requestPath, candidateSourceCommit] = process.argv.slice(2);
if (!statusPath || !completionPath || !requestPath || !candidateSourceCommit) throw new Error("Pass status, completion, request JSON paths and candidate source commit.");
const statusPayload = JSON.parse(readFileSync(statusPath, "utf8")) as ReleaseControlStatus & { runtime: ReleaseRuntimeEvidence };
const completion = JSON.parse(readFileSync(completionPath, "utf8")) as ReleaseCompletion;
const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReleaseControlRequest;
console.log(JSON.stringify(reconcileCutover({ request, candidateSourceCommit, status: statusPayload, runtime: statusPayload.runtime, completion, previousLegalVersion: "2026-08-23.2" })));
