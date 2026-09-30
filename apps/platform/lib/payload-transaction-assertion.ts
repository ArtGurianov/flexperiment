import type { Payload } from "payload";

type TransactionalPayload = Pick<Payload, "db">;

export async function assertPayloadTransactions(payload: TransactionalPayload): Promise<void> {
  const transactionID = await payload.db.beginTransaction();
  if (!transactionID) throw new Error("PAYLOAD_TRANSACTIONS_DISABLED");
  await payload.db.rollbackTransaction(transactionID);
}
