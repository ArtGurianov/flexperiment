import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { RuntimeInstanceEvidenceRecorder } from "./runtime-instance-evidence";
import { isSourceCommit, type RuntimeUnit } from "./runtime-identity";

/**
 * Starts recording what this process is, so readiness can see it.
 *
 * Readiness asks whether every surface serves the target release. The frontend
 * and the admin answer over HTTP, through the descriptor they publish; the
 * commerce API and the worker have no such surface, and their answer is this
 * table. A runtime that recorded nothing is a runtime readiness cannot see -
 * and one that recorded a commit it cannot vouch for is worse.
 *
 * The instance id is per process. Two rows for the same unit is the point: an
 * old instance that has not stopped is exactly what readiness exists to catch.
 */

export const RUNTIME_HEARTBEAT_INTERVAL_MS = 15_000;

export type RuntimeInstance = {
  readonly recorder: RuntimeInstanceEvidenceRecorder;
  readonly stop: () => void;
};

/**
 * Absent or malformed `SOURCE_COMMIT` is not fatal here, and deliberately so.
 * In development it is simply unset, and a process that refused to start
 * without it would make the development database unusable. What it must not do
 * is record something it cannot vouch for, so it records nothing at all -
 * which readiness reads as "not converged", the correct answer.
 */
export const startRuntimeInstance = (db: Database.Database, unit: RuntimeUnit): RuntimeInstance | undefined => {
  const sourceCommit = process.env.SOURCE_COMMIT?.trim();
  if (!isSourceCommit(sourceCommit)) {
    console.warn(`Runtime evidence not recorded: SOURCE_COMMIT is ${sourceCommit ? "not a commit" : "unset"}.`);
    return undefined;
  }

  const recorder = new RuntimeInstanceEvidenceRecorder(db, process.env.COMMERCE_INSTANCE_ID?.trim() || randomUUID(), unit);
  recorder.start(sourceCommit);

  const timer = setInterval(() => {
    try { recorder.heartbeat(); }
    catch (error) { console.error("Runtime heartbeat failed", error instanceof Error ? error.message : "unknown error"); }
  }, RUNTIME_HEARTBEAT_INTERVAL_MS);
  // A heartbeat must never be the reason a process outlives its work.
  timer.unref?.();

  return { recorder, stop: () => clearInterval(timer) };
};
