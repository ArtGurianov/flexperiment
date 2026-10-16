import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyV2Migration, V2_SCHEMA_LINEAGE } from "../src/db";

const migrationDirectory = join(process.cwd(), "commerce-v2", "migrations");
const fingerprint = (db: Database.Database) => createHash("sha256").update(JSON.stringify(db.prepare(
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
).all())).digest("hex");

describe("reviewed merchant schema across the editorial upgrade", () => {
  it("pins both real migration states without changing the independent erasure database", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys=ON");
    try {
      const migrations = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort();
      expect(migrations.length).toBeGreaterThanOrEqual(26);
      for (const name of migrations.slice(0, 25)) {
        applyV2Migration(db, name, readFileSync(join(migrationDirectory, name), "utf8"));
      }
      expect(fingerprint(db)).toBe("158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030");
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 25 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='course_editorial_versions'").get()).toBeUndefined();

      applyV2Migration(db, migrations[25], readFileSync(join(migrationDirectory, migrations[25]), "utf8"));
      expect(fingerprint(db)).toBe("c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39");
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 26 });
      expect(db.prepare("SELECT lineage FROM schema_identity WHERE singleton=1").get()).toEqual({ lineage: V2_SCHEMA_LINEAGE });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });
});
