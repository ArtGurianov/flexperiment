import type { BaseDatabaseAdapter, DatabaseAdapterObj } from "payload";

type TransactionID = number | string;

/**
 * SQLite only permits one writer at a time. The libSQL driver used by the
 * pinned Payload stack does not wait for a concurrent BEGIN WRITE, so keep
 * the whole Payload transaction lifetime behind a single-instance queue.
 */
export function serializeDatabaseTransactions<T extends BaseDatabaseAdapter>(
  database: DatabaseAdapterObj<T>,
): DatabaseAdapterObj<T> {
  const initialize = database.init;

  return {
    ...database,
    init(args) {
      const adapter = initialize(args);
      const beginTransaction = adapter.beginTransaction.bind(adapter);
      const commitTransaction = adapter.commitTransaction.bind(adapter);
      const rollbackTransaction = adapter.rollbackTransaction.bind(adapter);
      const releases = new Map<TransactionID, () => void>();
      let queue = Promise.resolve();

      adapter.beginTransaction = async (options) => {
        let release = () => {};
        const turn = new Promise<void>((resolve) => {
          release = resolve;
        });
        const previous = queue;
        queue = previous.catch(() => {}).then(() => turn);
        await previous.catch(() => {});

        try {
          const transactionID = await beginTransaction(options);
          if (transactionID === null) {
            release();
            return null;
          }
          releases.set(transactionID, release);
          return transactionID;
        } catch (error) {
          release();
          throw error;
        }
      };

      const releaseTransaction = (transactionID: TransactionID) => {
        const release = releases.get(transactionID);
        releases.delete(transactionID);
        release?.();
      };

      adapter.commitTransaction = async (incomingID) => {
        const transactionID = await Promise.resolve(incomingID);
        try {
          await commitTransaction(transactionID);
        } finally {
          releaseTransaction(transactionID);
        }
      };

      adapter.rollbackTransaction = async (incomingID) => {
        const transactionID = await Promise.resolve(incomingID);
        try {
          await rollbackTransaction(transactionID);
        } finally {
          releaseTransaction(transactionID);
        }
      };

      return adapter;
    },
  };
}
