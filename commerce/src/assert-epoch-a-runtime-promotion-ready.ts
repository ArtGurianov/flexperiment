import { readFileSync } from "node:fs";
import { epochARuntimeReady } from "./epoch-a-runtime-promotion";
import type { ReleaseControlRequest, ReleaseControlStatus, ReleaseRuntimeEvidence } from "./release-control";

const [statusPath, requestPath, legalPath, expectedSalesState] = process.argv.slice(2);
if (!statusPath || !requestPath || !legalPath || !["paused", "open"].includes(expectedSalesState ?? "")) {
  throw new Error("Pass status JSON, request JSON, legal JSON, and expected sales state (paused or open).");
}

const status = JSON.parse(readFileSync(statusPath, "utf8")) as ReleaseControlStatus & { runtime: ReleaseRuntimeEvidence };
const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReleaseControlRequest;
const legal = JSON.parse(readFileSync(legalPath, "utf8")) as { version?: unknown; occurrence_notifications_available?: unknown };
const salesStateMatches = expectedSalesState === "paused"
  ? status.sales_paused === true && status.owner_release_id === request.release_id
  : status.sales_paused === false && status.owner_release_id === null && status.owner_mode === null;
if (!salesStateMatches) {
  console.error("EPOCH_A_SALES_STATE_MISMATCH");
  process.exitCode = 1;
} else {
  const reason = epochARuntimeReady(request, status.runtime, {
    version: typeof legal.version === "string" ? legal.version : null,
    occurrenceNotificationsAvailable: typeof legal.occurrence_notifications_available === "boolean" ? legal.occurrence_notifications_available : null,
  });
  if (reason) {
    console.error(reason);
    process.exitCode = 1;
  }
}
