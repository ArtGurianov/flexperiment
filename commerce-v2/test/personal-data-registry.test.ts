import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  assertSchemaCoverage,
  generatedPath,
  readRegistry,
  renderRegistry,
} from "../../scripts/ci/personal-data-registry";
import { migrateV2 } from "../src/db";

const classified = readRegistry();

function withMigratedDatabase(check: (db: Database.Database) => void) {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    migrateV2(db);
    check(db);
  } finally {
    db.close();
  }
}

describe("Commerce V2 personal data registry", () => {
  it("covers the complete migrated schema including the runner journal", () => {
    expect(classified.registry.sqlite.schema_migrations).toEqual([
      expect.objectContaining({
        classification: "non_personal",
        columns: ["version", "applied_at", "sha256"],
      }),
    ]);
    withMigratedDatabase(db => assertSchemaCoverage(db, classified.registry));
  });

  it("fails on a column added to an otherwise classified non-personal table", () => {
    withMigratedDatabase(db => {
      db.exec("ALTER TABLE cities ADD COLUMN fixture_person_key TEXT");
      expect(() => assertSchemaCoverage(db, classified.registry)).toThrow(
        "DATA_REGISTRY_UNCLASSIFIED_COLUMN: cities.fixture_person_key",
      );
    });
  });

  it("fails when a column remains in the registry after removal from SQLite", () => {
    withMigratedDatabase(db => {
      db.exec("ALTER TABLE cities DROP COLUMN created_at");
      expect(() => assertSchemaCoverage(db, classified.registry)).toThrow(
        "DATA_REGISTRY_STALE_COLUMN: cities.created_at",
      );
    });
  });

  it("rejects duplicate YAML keys instead of accepting the last definition", () => {
    expect(() => readRegistry("version: 1\nversion: 1\n")).toThrow("DATA_REGISTRY_YAML");
  });

  it("rejects duplicate column classifications", () => {
    const registry = structuredClone(classified.registry);
    registry.sqlite.cities.push(registry.sqlite.cities[0]);
    expect(() => readRegistry(JSON.stringify(registry))).toThrow("DATA_REGISTRY_DUPLICATE_COLUMN: cities.");
  });

  it("requires a processing purpose for personal data", () => {
    const registry = structuredClone(classified.registry);
    const group = registry.sqlite.lesson_completions[0];
    if (group.classification === "non_personal") throw new Error("INVALID_SYNTHETIC_FIXTURE");
    group.purposes = [];
    expect(() => readRegistry(JSON.stringify(registry))).toThrow(/purposes/);
  });

  it("rejects a missing purpose reference", () => {
    const registry = structuredClone(classified.registry);
    const group = registry.sqlite.lesson_completions[0];
    if (group.classification === "non_personal") throw new Error("INVALID_SYNTHETIC_FIXTURE");
    group.purposes = ["missing_fixture_purpose"];
    expect(() => readRegistry(JSON.stringify(registry))).toThrow("DATA_REGISTRY_UNKNOWN_PURPOSE");
  });

  it("rejects raw export of a secret or mixed record", () => {
    for (const table of ["verification", "audit_log"]) {
      const registry = structuredClone(classified.registry);
      const group = registry.sqlite[table][0];
      if (group.classification === "non_personal") throw new Error("INVALID_SYNTHETIC_FIXTURE");
      group.access = "value";
      expect(() => readRegistry(JSON.stringify(registry))).toThrow(`DATA_REGISTRY_UNSAFE_VALUE_EXPORT: ${table}.`);
    }
  });

  it("matches the committed human-readable document byte for byte", () => {
    expect(readFileSync(generatedPath, "utf8")).toBe(renderRegistry(classified));
  });
});
