import { readFileSync } from "node:fs";
import { reconcileGenericProductionDeploy } from "./generic-production-deploy";
import type { ReleaseCompletion, ReleaseControlRequest, ReleaseControlStatus, ReleaseRuntimeEvidence } from "./release-control";

const [statusPath, completionPath, requestPath] = process.argv.slice(2);
if (!statusPath || !completionPath || !requestPath) throw new Error("Pass status, completion, and request JSON paths.");
const status = JSON.parse(readFileSync(statusPath, "utf8")) as ReleaseControlStatus & { runtime: ReleaseRuntimeEvidence };
const completion = JSON.parse(readFileSync(completionPath, "utf8")) as ReleaseCompletion;
const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReleaseControlRequest;
console.log(JSON.stringify(reconcileGenericProductionDeploy({ request, status, runtime: status.runtime, completion })));
