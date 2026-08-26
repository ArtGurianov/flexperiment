import { readFileSync } from "node:fs";
import { evaluateReopenGate, type ReleaseControlRequest, type ReleaseControlStatus, type ReleaseRuntimeEvidence } from "./release-control";

const [statusPath, requestPath, expectedSalesState] = process.argv.slice(2);
if (!statusPath || !requestPath || !["paused", "open"].includes(expectedSalesState ?? "")) throw new Error("Pass status JSON, request JSON, and expected sales state (paused or open).");
const status = JSON.parse(readFileSync(statusPath, "utf8")) as ReleaseControlStatus & { runtime: ReleaseRuntimeEvidence };
const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReleaseControlRequest;
const salesStateMatches = expectedSalesState === "paused"
  ? status.sales_paused === true && status.owner_release_id === request.release_id
  : status.sales_paused === false && status.owner_release_id === null && status.owner_mode === null;
if (!salesStateMatches) {
  console.error("GENERIC_DEPLOY_SALES_STATE_MISMATCH");
  process.exitCode = 1;
} else {
  const reason = evaluateReopenGate(request, status.runtime);
  if (reason) {
    console.error(reason);
    process.exitCode = 1;
  }
}
