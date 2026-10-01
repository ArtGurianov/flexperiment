import type { BaseDatabaseAdapter, DatabaseAdapterObj } from "payload";

type TransactionID = number | string;

export class TransactionTerminatedError extends Error {
  constructor() {
    super("TRANSACTION_TERMINATED");
    this.name = "TransactionTerminatedError";
  }
}

/** Lifecycle of the transactions opened through {@link serializeDatabaseTransactions}. */
export type TransactionControl = {
  /**
   * Runs `callback` once the transaction has committed or rolled back — immediately when it is
   * not open. A transaction whose termination could not be proven never ends here.
   */
  onEnded(transactionID: TransactionID, callback: () => void): void;
  /**
   * Force-terminates an open transaction. It is rolled back, and from then on every session lookup
   * for its ID and every write made for `req` fails instead of falling back to the autocommit
   * connection, so a request that outlived its hard lifetime can never commit part of its work.
   */
  terminate(transactionID: TransactionID, req?: object): Promise<void>;
};

const controls = new WeakMap<object, TransactionControl>();

/** The control installed on an adapter by {@link serializeDatabaseTransactions}, if any. */
export const transactionControl = (db: object): TransactionControl | undefined => controls.get(db);

const writeMethods = [
  "create", "createGlobal", "createGlobalVersion", "createVersion", "deleteMany", "deleteOne", "deleteVersions",
  "updateGlobal", "updateGlobalVersion", "updateJobs", "updateMany", "updateOne", "updateVersion", "upsert",
] as const;

const terminatedSession = {
  db: new Proxy({}, { get() { throw new TransactionTerminatedError(); } }),
  resolve: async () => { throw new TransactionTerminatedError(); },
  reject: async () => {},
};

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
      const endCallbacks = new Map<TransactionID, Array<() => void>>();
      const ending = new Set<TransactionID>();
      const terminated = new Set<string>();
      const terminatedRequests = new WeakSet<object>();
      let queue = Promise.resolve();

      // Drizzle resolves a request's session as `sessions[id]?.db || drizzle`: once a session is
      // gone, its queries silently run on the autocommit connection. A terminated ID resolves to a
      // session whose every use throws instead.
      const holder = adapter as unknown as { sessions?: Record<string, unknown> };
      if (holder.sessions) {
        holder.sessions = new Proxy(holder.sessions, {
          get: (target, key, receiver) => typeof key === "string" && !Reflect.has(target, key) && terminated.has(key)
            ? terminatedSession
            : Reflect.get(target, key, receiver),
          has: (target, key) => Reflect.has(target, key) || (typeof key === "string" && terminated.has(key)),
        });
      }

      const writable = adapter as unknown as Record<string, unknown>;
      for (const method of writeMethods) {
        const write = writable[method];
        if (typeof write !== "function") continue;
        writable[method] = function guardedWrite(this: unknown, writeArgs?: { req?: object }) {
          if (writeArgs?.req && terminatedRequests.has(writeArgs.req)) return Promise.reject(new TransactionTerminatedError());
          return (write as (input: unknown) => unknown).call(adapter, writeArgs);
        };
      }

      const finish = (transactionID: TransactionID) => {
        const release = releases.get(transactionID);
        releases.delete(transactionID);
        ending.delete(transactionID);
        release?.();
        const callbacks = endCallbacks.get(transactionID) ?? [];
        endCallbacks.delete(transactionID);
        for (const callback of callbacks) callback();
      };

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

      adapter.commitTransaction = async (incomingID) => {
        const transactionID = await Promise.resolve(incomingID);
        if (terminated.has(String(transactionID))) throw new TransactionTerminatedError();
        ending.add(transactionID);
        try {
          await commitTransaction(transactionID);
        } finally {
          finish(transactionID);
        }
      };

      adapter.rollbackTransaction = async (incomingID) => {
        const transactionID = await Promise.resolve(incomingID);
        if (terminated.has(String(transactionID))) return;
        ending.add(transactionID);
        try {
          await rollbackTransaction(transactionID);
        } finally {
          finish(transactionID);
        }
      };

      const onEnded: TransactionControl["onEnded"] = (transactionID, callback) => {
        if (!releases.has(transactionID)) {
          callback();
          return;
        }
        endCallbacks.set(transactionID, [...(endCallbacks.get(transactionID) ?? []), callback]);
      };

      controls.set(adapter, {
        onEnded,
        async terminate(transactionID, req) {
          if (req) terminatedRequests.add(req);
          if (!releases.has(transactionID) || terminated.has(String(transactionID))) return;
          if (ending.has(transactionID)) {
            // A commit or rollback already owns the outcome; termination waits for it, never races it.
            await new Promise<void>((resolve) => onEnded(transactionID, resolve));
            return;
          }
          terminated.add(String(transactionID));
          // Drizzle's rollback settles only after the transaction callback has rolled back. If it
          // throws, the end is unproven: the transaction stays open here and keeps the writer queue.
          await rollbackTransaction(transactionID);
          finish(transactionID);
        },
      });

      return adapter;
    },
  };
}
