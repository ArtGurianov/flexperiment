import { describe, expect, it, vi } from "vitest";
import { assertPayloadTransactions } from "../lib/payload-transaction-assertion";
import {
  beginInFlightOperation,
  operationIsInFlight,
  terminateTimedOutOperation,
} from "../lib/manifest/in-flight";

describe("Payload runtime safety", () => {
  it("fails initialization when the adapter cannot start a transaction", async () => {
    await expect(assertPayloadTransactions({
      db: { beginTransaction: vi.fn().mockResolvedValue(null) },
    } as never)).rejects.toThrow("PAYLOAD_TRANSACTIONS_DISABLED");
  });

  it("opens and rolls back the startup probe transaction", async () => {
    const rollbackTransaction = vi.fn().mockResolvedValue(undefined);
    await assertPayloadTransactions({
      db: { beginTransaction: vi.fn().mockResolvedValue("startup-probe"), rollbackTransaction },
    } as never);
    expect(rollbackTransaction).toHaveBeenCalledWith("startup-probe");
  });

  it("kills an expired transaction and clears the in-flight proof only after rollback finishes", async () => {
    let finishRollback: (() => void) | undefined;
    const rollbackTransaction = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finishRollback = resolve; }));
    const req = {
      headers: new Headers({ "x-platform-request-id": "request" }),
      transactionID: Promise.resolve("transaction"),
      payload: { db: { rollbackTransaction }, logger: { error: vi.fn() } },
    } as never;
    beginInFlightOperation("operation", req);
    const terminating = terminateTimedOutOperation("operation", req);
    await vi.waitFor(() => expect(rollbackTransaction).toHaveBeenCalledWith("transaction"));
    expect(operationIsInFlight("operation")).toBe(true);
    finishRollback?.();
    await terminating;
    expect(operationIsInFlight("operation")).toBe(false);
  });
});
