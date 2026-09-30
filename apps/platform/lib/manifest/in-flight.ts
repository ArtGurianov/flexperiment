import { randomUUID } from "node:crypto";
import type { PayloadRequest } from "payload";

const processEpoch = randomUUID();
const hardLifetimeMs = Number(process.env.PLATFORM_SAVE_HARD_LIFETIME_MS ?? 60_000);

type Entry = {
  readonly operationId: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly deadlineAt: string;
  transactionEnded: boolean;
  killed: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const entries = new Map<string, Entry>();

export async function terminateTimedOutOperation(operationId: string, req: PayloadRequest): Promise<void> {
  const live = entries.get(operationId);
  if (!live || live.transactionEnded) return;
  live.killed = true;
  try {
    const transactionID = await req.transactionID;
    if (transactionID) await req.payload.db.rollbackTransaction(transactionID);
  } finally {
    clearTimeout(live.timer);
    live.transactionEnded = true;
    entries.delete(operationId);
  }
}

export const getPlatformEpoch = () => processEpoch;
export const getSaveLifetimeMs = () => hardLifetimeMs;

export function requestCorrelationId(req: PayloadRequest): string {
  return req.headers.get("x-platform-request-id") ?? "local-api";
}

export function beginInFlightOperation(operationId: string, req: PayloadRequest, now = new Date()): Entry {
  const requestId = requestCorrelationId(req);
  const deadline = new Date(now.getTime() + hardLifetimeMs);
  const entry: Entry = {
    operationId,
    requestId,
    createdAt: now.toISOString(),
    deadlineAt: deadline.toISOString(),
    transactionEnded: false,
    killed: false,
    timer: setTimeout(() => undefined, hardLifetimeMs),
  };
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    void terminateTimedOutOperation(operationId, req).catch((error) => {
      req.payload.logger.error({ err: error, msg: "Failed to terminate an expired LMS content transaction" });
    });
  }, hardLifetimeMs);
  entry.timer.unref?.();
  entries.set(operationId, entry);
  return entry;
}

export function finishPlatformRequest(requestId: string): void {
  for (const [operationId, entry] of entries) {
    if (entry.requestId !== requestId) continue;
    clearTimeout(entry.timer);
    entry.transactionEnded = true;
    entries.delete(operationId);
  }
}

export function finishLocalOperation(operationId: string): void {
  const entry = entries.get(operationId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.transactionEnded = true;
  entries.delete(operationId);
}

export function operationIsInFlight(operationId: string): boolean {
  return entries.has(operationId);
}

export function snapshotInFlight(): ReadonlyArray<Omit<Entry, "timer">> {
  return [...entries.values()].map((entry) => ({
    operationId: entry.operationId,
    requestId: entry.requestId,
    createdAt: entry.createdAt,
    deadlineAt: entry.deadlineAt,
    transactionEnded: entry.transactionEnded,
    killed: entry.killed,
  }));
}
