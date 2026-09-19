import type Database from "better-sqlite3";

/**
 * Operator-owned absolute stop. This is intentionally independent from the
 * P2 deployment-session model: a certification capability must never bypass
 * this gate.
 */
export const emergencySalesPaused = (db: Database.Database): boolean => {
  const row = db.prepare("SELECT sales_paused FROM emergency_sales_gate WHERE singleton = 1").get() as { sales_paused?: unknown } | undefined;
  return Number(row?.sales_paused ?? 1) === 1;
};
