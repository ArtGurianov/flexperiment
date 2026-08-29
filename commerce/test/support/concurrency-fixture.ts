import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { migrate, openDatabase, type Sqlite } from "../../src/db";

/**
 * A real on-disk database with several independent connections.
 *
 * `:memory:` is per-connection, so it cannot express any of the properties
 * worth testing here: that WAL and `BEGIN IMMEDIATE` actually serialize
 * competing writers, that a durable gate survives a process restart, and that
 * a transition losing a CAS race is refused rather than silently applied.
 * Those hold today by construction; this makes them an executable contract so
 * a later refactor cannot quietly drop them.
 */
export function concurrencyFixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "flexperiment-concurrency-"));
  const path = resolve(directory, "commerce.sqlite");
  const connections: Sqlite[] = [];

  const connect = (): Sqlite => {
    const sqlite = openDatabase(path);
    connections.push(sqlite);
    return sqlite;
  };

  const primary = connect();
  migrate(primary);

  return {
    path,
    primary,
    connect,
    /** Drops every connection and reopens: the process-restart boundary. */
    restart(): Sqlite {
      while (connections.length) connections.pop()?.close();
      return connect();
    },
    close() {
      while (connections.length) {
        try { connections.pop()?.close(); } catch { /* already closed by restart */ }
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type ConcurrencyFixture = ReturnType<typeof concurrencyFixture>;
