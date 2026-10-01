import { randomUUID } from "node:crypto";
import type { PayloadRequest } from "payload";
import { transactionControl } from "@/lib/serialized-transactions";

const processEpoch = randomUUID();

type Entry = {
  readonly operationId: string;
  readonly transactionID: number | string;
  readonly createdAt: string;
  readonly deadlineAt: string;
  killed: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const entries = new Map<string, Entry>();

export const getPlatformEpoch = () => processEpoch;
export const getSaveLifetimeMs = () => Number(process.env.PLATFORM_SAVE_HARD_LIFETIME_MS ?? 60_000);

const controlFor = (req: PayloadRequest) => {
  const control = transactionControl(req.payload.db);
  if (!control) throw new Error("PAYLOAD_TRANSACTION_CONTROL_MISSING");
  return control;
};

/** Kills the save's transaction once its hard lifetime is spent; the entry clears when the kill has finished. */
export async function terminateTimedOutOperation(operationId: string, req: PayloadRequest): Promise<void> {
  const live = entries.get(operationId);
  if (!live) return;
  live.killed = true;
  await controlFor(req).terminate(live.transactionID, req);
}

/**
 * Registers a restrictive operation against the transaction that carries it. The entry is removed
 * only when that transaction has committed or been rolled back or killed — never when an HTTP
 * request, a job or a timer merely finishes — so "not in flight" always proves it can no longer commit.
 */
export async function beginInFlightOperation(operationId: string, req: PayloadRequest, now = new Date()): Promise<Readonly<Entry>> {
  const transactionID = await req.transactionID;
  if (!transactionID) throw new Error("RESTRICTIVE_SAVE_REQUIRES_TRANSACTION");
  const control = controlFor(req);
  const lifetimeMs = getSaveLifetimeMs();
  const entry: Entry = {
    operationId,
    transactionID,
    createdAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + lifetimeMs).toISOString(),
    killed: false,
    timer: setTimeout(() => {
      void terminateTimedOutOperation(operationId, req).catch((error) => {
        req.payload.logger.error({ err: error, msg: "Failed to terminate an expired LMS content transaction" });
      });
    }, lifetimeMs),
  };
  entry.timer.unref?.();
  entries.set(operationId, entry);
  control.onEnded(transactionID, () => {
    clearTimeout(entry.timer);
    entries.delete(operationId);
  });
  return entry;
}

export function operationIsInFlight(operationId: string): boolean {
  return entries.has(operationId);
}

export function snapshotInFlight(): ReadonlyArray<Pick<Entry, "operationId" | "createdAt" | "deadlineAt" | "killed">> {
  return [...entries.values()].map((entry) => ({
    operationId: entry.operationId,
    createdAt: entry.createdAt,
    deadlineAt: entry.deadlineAt,
    killed: entry.killed,
  }));
}
