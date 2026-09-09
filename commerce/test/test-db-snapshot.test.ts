import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { openUnmigratedTestDatabase } from "./support/test-database";

describe("test-only migrated database snapshot", () => {
  it("provides the canonical snapshot path to every Vitest worker", () => {
    expect(process.env.COMMERCE_TEST_DB_SNAPSHOT_PATH).toMatch(/migrated\.sqlite$/);
  });

  it("clones the real migrated schema without leaking fixture writes", () => {
    const first = openDatabase(":memory:");
    try {
      expect(first.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: readdirSync(join(process.cwd(), "commerce", "migrations")).filter((file) => file.endsWith(".sql")).length,
      });
      first.prepare("INSERT INTO cities(id, slug, title) VALUES ('first', 'first', 'First')").run();

      const second = openDatabase(":memory:");
      migrate(second);
      try {
        expect(second.prepare("SELECT COUNT(*) AS count FROM cities").get()).toEqual({ count: 0 });
        expect(second.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual(
          first.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
        );
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it("clones the template into each new file-backed fixture without overwriting an existing database", () => {
    const directory = mkdtempSync(join(tmpdir(), "commerce-test-db-snapshot-"));
    const first = openDatabase(join(directory, "first.sqlite"));
    try {
      first.prepare("INSERT INTO cities(id, slug, title) VALUES ('first-file', 'first-file', 'First file')").run();

      const second = openDatabase(join(directory, "second.sqlite"));
      try {
        expect(second.prepare("SELECT COUNT(*) AS count FROM cities").get()).toEqual({ count: 0 });
        expect(second.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual(
          first.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
        );
      } finally {
        second.close();
      }

      const reopened = openDatabase(join(directory, "first.sqlite"));
      try {
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM cities WHERE id = 'first-file'").get()).toEqual({ count: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not change ordinary production-style migration behavior when the flag is absent", () => {
    const previous = process.env.COMMERCE_TEST_DB_SNAPSHOT;
    delete process.env.COMMERCE_TEST_DB_SNAPSHOT;
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: readdirSync(join(process.cwd(), "commerce", "migrations")).filter((file) => file.endsWith(".sql")).length,
      });
    } finally {
      db.close();
      if (previous === undefined) delete process.env.COMMERCE_TEST_DB_SNAPSHOT;
      else process.env.COMMERCE_TEST_DB_SNAPSHOT = previous;
    }
  });

  it("gives migration-semantic tests a truly empty database even when snapshots are enabled", () => {
    const db = openUnmigratedTestDatabase();
    try {
      expect(() => db.prepare("SELECT * FROM schema_migrations").all()).toThrow();
    } finally {
      db.close();
    }
  });
});
