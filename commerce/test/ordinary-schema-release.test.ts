import { describe, expect, it } from "vitest";
import { admitOrdinarySchemaRelease } from "../src/ordinary-schema-release";

const base = new Map([["0058_base.sql", "base-blob"]]);
const target = new Map([...base, ["0059_next.sql", "next-blob"]]);
const schemaPaths = ["commerce/migrations/0059_next.sql", "commerce/src/domain.ts"];

describe("ordinary schema release admission", () => {
  it.each([
    ["legal", ["commerce/migrations/0059_next.sql", "public/legal/public-offer.md"], base, target, "ORDINARY_SCHEMA_LEGAL_CHANGED"],
    ["compatibility", ["commerce/migrations/0059_next.sql", "commerce/src/crypto.ts"], base, target, "ORDINARY_SCHEMA_RELEASE_SEMANTICS_CHANGED=COMPATIBILITY"],
    ["release control", ["commerce/migrations/0059_next.sql", "commerce/src/release-control.ts"], base, target, "ORDINARY_SCHEMA_RELEASE_SEMANTICS_CHANGED=RELEASE_CONTROL"],
    ["historical mutation", schemaPaths, base, new Map([["0058_base.sql", "changed"], ["0059_next.sql", "next-blob"]]), "ORDINARY_SCHEMA_HISTORICAL_MIGRATION_CHANGED=0058_base.sql"],
    ["historical deletion", schemaPaths, base, new Map([["0059_next.sql", "next-blob"]]), "ORDINARY_SCHEMA_HISTORICAL_MIGRATION_MISSING=0058_base.sql"],
  ])("rejects %s", (_name, changedPaths, baseline, candidate, code) => {
    expect(() => admitOrdinarySchemaRelease({ changedPaths, baseMigrationBlobs: baseline, targetMigrationBlobs: candidate })).toThrow(code);
  });

  it("admits an append-only schema delta and derives the target inventory expectation", () => {
    const admitted = admitOrdinarySchemaRelease({ changedPaths: schemaPaths, baseMigrationBlobs: base, targetMigrationBlobs: target });
    expect(admitted.newMigrations).toEqual(["0059_next.sql"]);
    expect(admitted.targetMigrationExpectation).toMatch(/^inventory-sha256:[a-f0-9]{64}$/);
  });
});
