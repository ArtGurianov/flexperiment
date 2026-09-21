import type Database from "better-sqlite3";
import { emergencySalesPaused } from "../emergency-sales-gate";
import type { SalesGateState } from "./sales-gate";

/**
 * The gate as the request path sees it.
 *
 * Until this existed, `deployment_gate_closed` was read only by the release
 * machinery: a maintenance cutover recorded a closed fence that nothing in the
 * public checkout ever consulted, so the fence shut nothing. The session state
 * and the customer's experience have to be the same fact, and this is where
 * they become one.
 *
 * A missing emergency row reads as closed - losing the gate is not the same as
 * clearing it - and that behaviour belongs to `emergencySalesPaused`, which is
 * deliberately independent of the deployment model.
 */
export const readSalesGateState = (db: Database.Database): SalesGateState => {
  const fence = db.prepare("SELECT id FROM deploy_sessions WHERE deployment_gate_closed = 1").get() as { id: string } | undefined;
  return {
    emergencyClosed: emergencySalesPaused(db),
    deploymentClosed: fence !== undefined,
    deploymentSessionId: fence?.id ?? null,
    // Ordinary product rules are per-occurrence - visibility, sales status,
    // fulfilment, availability - and are enforced where the occurrence is
    // known. There is no global business stop, and inventing one here would be
    // a second place able to disagree with those.
    businessClosed: false,
  };
};
