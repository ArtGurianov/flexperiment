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

  it("fails on a column in a new, unclassified table", () => {
    withMigratedDatabase(db => {
      db.exec("CREATE TABLE fixture_unclassified (id TEXT)");
      expect(() => assertSchemaCoverage(db, classified.registry)).toThrow(
        "DATA_REGISTRY_UNCLASSIFIED_COLUMN: fixture_unclassified.id",
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

  it("rejects duplicate purpose references", () => {
    const registry = structuredClone(classified.registry);
    const group = registry.sqlite.lesson_completions[0];
    if (group.classification === "non_personal") throw new Error("INVALID_SYNTHETIC_FIXTURE");
    group.purposes.push(group.purposes[0]);
    expect(() => readRegistry(JSON.stringify(registry))).toThrow("DATA_REGISTRY_DUPLICATE_PURPOSE: lesson_completions.");
  });

  it("rejects missing gap and source references", () => {
    const registry = structuredClone(classified.registry);
    registry.stores.support_mail.review = "missing_fixture_gap";
    expect(() => readRegistry(JSON.stringify(registry))).toThrow("DATA_REGISTRY_UNKNOWN_GAP: support_mail");

    registry.stores.support_mail.review = classified.registry.stores.support_mail.review;
    registry.purposes.identity.sources = ["missing_fixture_source"];
    expect(() => readRegistry(JSON.stringify(registry))).toThrow("DATA_REGISTRY_UNKNOWN_SOURCE: identity");
  });

  it("rejects raw export of a secret or mixed record", () => {
    for (const table of ["verification", "audit_log"]) {
      const registry = structuredClone(classified.registry);
      const group = registry.sqlite[table][0];
      if (group.classification === "non_personal") throw new Error("INVALID_SYNTHETIC_FIXTURE");
      expect(["secret", "mixed"]).toContain(group.classification);
      group.access = "value";
      expect(() => readRegistry(JSON.stringify(registry))).toThrow(`DATA_REGISTRY_UNSAFE_VALUE_EXPORT: ${table}.`);
    }
  });

  it("rejects a secret marked for projected export", () => {
    const registry = structuredClone(classified.registry);
    const group = registry.sqlite.session.find(group => group.columns.includes("token"));
    if (group?.classification !== "secret") throw new Error("INVALID_SYNTHETIC_FIXTURE");
    group.access = "projection";
    expect(() => readRegistry(JSON.stringify(registry))).toThrow("DATA_REGISTRY_UNSAFE_SECRET_PROJECTION: session.token");
  });

  it.each([
    ["session", "token"],
    ["verification", "value"],
    ["account", "password"],
    ["control_room_totp", "seed_ciphertext"],
    ["lab_tickets", "qr_sha256"],
  ])("rejects marking %s.%s as exportable personal data", (table, column) => {
    const registry = structuredClone(classified.registry);
    const group = registry.sqlite[table].find(group => group.columns.includes(column));
    if (group?.classification !== "secret") throw new Error("INVALID_SYNTHETIC_FIXTURE");
    group.classification = "personal";
    group.access = "value";
    expect(() => readRegistry(JSON.stringify(registry))).toThrow(`DATA_REGISTRY_PROTECTED_CLASSIFICATION: ${table}.${column}`);
  });

  it.each([
    ["customers", "email_normalized"],
    ["offers", "acceptance_allowlist_json"],
  ])("rejects marking %s.%s as non-personal", (table, column) => {
    const registry = structuredClone(classified.registry);
    const index = registry.sqlite[table].findIndex(group => group.columns.includes(column));
    registry.sqlite[table][index] = { columns: [column], classification: "non_personal", reason: "Synthetic misclassification" };
    expect(() => readRegistry(JSON.stringify(registry))).toThrow(`DATA_REGISTRY_PROTECTED_CLASSIFICATION: ${table}.${column}`);
  });

  it.each([
    "audit_log.evidence_json",
    "course_entitlements.revocation_reason",
    "lab_service_renditions.evidence_ref",
    "offers.acceptance_allowlist_json",
    "verification.value",
  ])("requires a descriptor for the payload in %s", location => {
    const registry = structuredClone(classified.registry);
    delete registry.payloads[location];
    expect(() => readRegistry(JSON.stringify(registry))).toThrow(`DATA_REGISTRY_MISSING_PAYLOAD: ${location}`);
  });

  it("requires a descriptor for new JSON even when classified as non-personal", () => {
    const registry = structuredClone(classified.registry);
    registry.sqlite.cities[0].columns.push("fixture_json");
    expect(() => readRegistry(JSON.stringify(registry))).toThrow("DATA_REGISTRY_MISSING_PAYLOAD: cities.fixture_json");
  });

  it("rejects a payload pointing to an inherited property or unmarked column", () => {
    for (const location of ["constructor.column", "cities.id"]) {
      const registry = structuredClone(classified.registry);
      registry.payloads[location] = { content: "Synthetic contents", review: "audit" };
      expect(() => readRegistry(JSON.stringify(registry))).toThrow(`DATA_REGISTRY_UNSAFE_PAYLOAD: ${location}`);
    }
  });

  it("requires explicit access and closure for an off-database store", () => {
    for (const attribute of ["access", "closure"] as const) {
      const registry = structuredClone(classified.registry);
      const policy: Partial<typeof registry.stores.support_mail> = registry.stores.support_mail;
      delete policy[attribute];
      expect(() => readRegistry(JSON.stringify(registry))).toThrow(new RegExp(`"${attribute}"`));
    }
  });

  it("matches the committed human-readable document byte for byte", () => {
    expect(readFileSync(generatedPath, "utf8")).toBe(renderRegistry(classified));
  });
});
