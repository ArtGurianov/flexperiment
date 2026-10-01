import { describe, expect, it, vi } from "vitest";
import { assertPayloadTransactions } from "../lib/payload-transaction-assertion";
import {
  beginInFlightOperation,
  operationIsInFlight,
  terminateTimedOutOperation,
} from "../lib/manifest/in-flight";
import { serializeDatabaseTransactions } from "../lib/serialized-transactions";

type Gate = { hold: boolean; open?: () => void };

/** A drizzle-shaped adapter: sessions live in `sessions`, and ending a transaction deletes its entry. */
function fakeDatabase() {
  const commitGate: Gate = { hold: false };
  const rollbackGate: Gate = { hold: false };
  const wait = (gate: Gate) => gate.hold ? new Promise<void>((resolve) => { gate.open = resolve; }) : Promise.resolve();
  let next = 0;
  const raw = {
    sessions: {} as Record<string, { db: { insert: () => string } }>,
    beginTransaction: vi.fn(async () => {
      const id = `transaction-${next += 1}`;
      raw.sessions[id] = { db: { insert: () => "transactional-write" } };
      return id;
    }),
    commitTransaction: vi.fn(async (id: string) => {
      delete raw.sessions[id];
      await wait(commitGate);
    }),
    rollbackTransaction: vi.fn(async (id: string) => {
      delete raw.sessions[id];
      await wait(rollbackGate);
    }),
    create: vi.fn<(args: unknown) => Promise<{ id: number }>>(async () => ({ id: 1 })),
  };
  // The wrapper replaces the adapter's methods in place, so keep the underlying spies.
  const spies = { commitTransaction: raw.commitTransaction, rollbackTransaction: raw.rollbackTransaction, create: raw.create };
  const db = serializeDatabaseTransactions({ name: "fake", defaultIDType: "number", init: () => raw } as never)
    .init({ payload: {} } as never) as unknown as typeof raw;
  const request = (transactionID: string) => ({ transactionID, payload: { db, logger: { error: vi.fn() } } }) as never;
  return { db, raw: spies, commitGate, rollbackGate, request };
}

describe("Payload runtime safety", () => {
  it("fails initialization when the adapter cannot start a transaction", async () => {
    await expect(assertPayloadTransactions({
      db: { beginTransaction: vi.fn().mockResolvedValue(null) },
    } as never)).rejects.toThrow("PAYLOAD_TRANSACTIONS_DISABLED");
  });

  it("opens and rolls back the startup probe and requires the transaction control", async () => {
    const { db, raw } = fakeDatabase();
    await assertPayloadTransactions({ db } as never);
    expect(raw.rollbackTransaction).toHaveBeenCalledWith("transaction-1");

    await expect(assertPayloadTransactions({
      db: { beginTransaction: vi.fn().mockResolvedValue("probe"), rollbackTransaction: vi.fn() },
    } as never)).rejects.toThrow("PAYLOAD_TRANSACTION_CONTROL_MISSING");
  });

  it("clears the in-flight proof when the carrying transaction commits", async () => {
    const { db, request } = fakeDatabase();
    const transactionID = await db.beginTransaction();
    await beginInFlightOperation("committed-operation", request(transactionID));
    expect(operationIsInFlight("committed-operation")).toBe(true);
    await db.commitTransaction(transactionID);
    expect(operationIsInFlight("committed-operation")).toBe(false);
  });

  it("kills an expired transaction, clears the proof only after rollback, and never falls back", async () => {
    const { db, raw, rollbackGate, request } = fakeDatabase();
    const transactionID = await db.beginTransaction();
    const req = request(transactionID);
    await beginInFlightOperation("killed-operation", req);

    rollbackGate.hold = true;
    const terminating = terminateTimedOutOperation("killed-operation", req);
    await vi.waitFor(() => expect(raw.rollbackTransaction).toHaveBeenCalledWith(transactionID));
    expect(operationIsInFlight("killed-operation")).toBe(true);
    rollbackGate.open?.();
    await terminating;
    expect(operationIsInFlight("killed-operation")).toBe(false);

    // Drizzle would resolve a missing session to the autocommit connection; a killed one throws.
    expect(() => db.sessions[transactionID]!.db.insert()).toThrow("TRANSACTION_TERMINATED");
    await expect(db.create({ collection: "access-operations", data: {}, req } as never)).rejects.toThrow("TRANSACTION_TERMINATED");
    await expect(db.commitTransaction(transactionID)).rejects.toThrow("TRANSACTION_TERMINATED");
    await expect(db.rollbackTransaction(transactionID)).resolves.toBeUndefined();
    expect(raw.create).not.toHaveBeenCalled();

    // The writer queue is free again, and other requests write normally.
    const nextTransaction = await db.beginTransaction();
    expect(db.sessions[nextTransaction]!.db.insert()).toBe("transactional-write");
    await expect(db.create({ collection: "access-operations", data: {}, req: request(nextTransaction) } as never)).resolves.toEqual({ id: 1 });
    await db.commitTransaction(nextTransaction);
  });

  it("lets a commit already in progress decide the outcome instead of racing it with a kill", async () => {
    const { db, raw, commitGate, request } = fakeDatabase();
    const transactionID = await db.beginTransaction();
    const req = request(transactionID);
    await beginInFlightOperation("committing-operation", req);

    commitGate.hold = true;
    const committing = db.commitTransaction(transactionID);
    await vi.waitFor(() => expect(raw.commitTransaction).toHaveBeenCalledWith(transactionID));
    const terminating = terminateTimedOutOperation("committing-operation", req);
    await Promise.resolve();
    expect(raw.rollbackTransaction).not.toHaveBeenCalled();
    expect(operationIsInFlight("committing-operation")).toBe(true);
    commitGate.open?.();
    await Promise.all([committing, terminating]);
    expect(raw.rollbackTransaction).not.toHaveBeenCalled();
    expect(operationIsInFlight("committing-operation")).toBe(false);
  });
});
