import Database from "better-sqlite3";
import { migrate } from "../../src/db";
import { InMemoryReleaseAuthorityStore, type ReleaseAuthorityStore } from "../../src/release/deploy-session";
import { SqliteReleaseAuthorityStore } from "../../src/release/deploy-session-store";

/**
 * Both implementations of the release authority, so the contract suite runs
 * against each.
 *
 * The in-memory store is the reference the semantics were designed against; the
 * SQLite store is what production writes to. A rule proved only against the
 * first is a rule about a class nothing deploys, and a suite that exercises only
 * the second cannot tell a contract violation from a SQL mistake.
 */
export const releaseAuthorityStores: ReadonlyArray<readonly [string, () => ReleaseAuthorityStore]> = [
  ["in-memory", () => new InMemoryReleaseAuthorityStore()],
  ["sqlite", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return new SqliteReleaseAuthorityStore(db);
  }],
];
