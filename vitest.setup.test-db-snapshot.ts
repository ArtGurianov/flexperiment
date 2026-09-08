import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "./commerce/src/db";

/** Builds one real final-schema image before Vitest starts its workers. */
export default function setupMigratedTestDatabaseSnapshot({
  provide,
}: {
  provide: (key: "commerceTestDbSnapshotPath", value: string | undefined) => void;
}) {
  if (process.env.COMMERCE_TEST_DB_SNAPSHOT !== "1") return;

  const directory = mkdtempSync(join(tmpdir(), "flexperiment-test-schema-"));
  const path = join(directory, "migrated.sqlite");
  const db = openDatabase(":memory:", { testSchemaSnapshot: false });
  try {
    migrate(db);
    writeFileSync(path, db.serialize(), { mode: 0o600 });
  } finally {
    db.close();
  }
  provide("commerceTestDbSnapshotPath", path);

  process.env.COMMERCE_TEST_DB_SNAPSHOT_PATH = path;
  return () => {
    delete process.env.COMMERCE_TEST_DB_SNAPSHOT_PATH;
    rmSync(directory, { recursive: true, force: true });
  };
}
