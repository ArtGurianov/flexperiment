import type { Payload } from "payload";
import { transactionControl } from "@/lib/serialized-transactions";

type TransactionalPayload = Pick<Payload, "db">;

export async function assertPayloadTransactions(payload: TransactionalPayload): Promise<void> {
  const transactionID = await payload.db.beginTransaction();
  if (!transactionID) throw new Error("PAYLOAD_TRANSACTIONS_DISABLED");
  await payload.db.rollbackTransaction(transactionID);
  // Restrictive saves rely on killing a transaction outright; without the control a kill would
  // fall back to the autocommit connection.
  if (!transactionControl(payload.db)) throw new Error("PAYLOAD_TRANSACTION_CONTROL_MISSING");
}
