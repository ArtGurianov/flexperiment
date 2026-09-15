import { describe, expect, it } from "vitest";
import { admitOrdinarySchemaRelease, classifyOrdinarySchemaDeployState } from "../src/ordinary-schema-release";

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
    ["late migration", schemaPaths, base, new Map([...base, ["0057_late.sql", "late-blob"]]), "ORDINARY_SCHEMA_MIGRATION_ORDER_INVALID=0057_late.sql"],
    ["malformed migration filename", schemaPaths, base, new Map([...base, ["0059_Late.sql", "next-blob"]]), "ORDINARY_SCHEMA_MIGRATION_FILENAME_INVALID=0059_Late.sql"],
  ])("rejects %s", (_name, changedPaths, baseline, candidate, code) => {
    expect(() => admitOrdinarySchemaRelease({ changedPaths, baseMigrationBlobs: baseline, targetMigrationBlobs: candidate })).toThrow(code);
  });

  it("admits ordered 0059/0060 append-only migrations and derives the target inventory expectation", () => {
    const orderedTarget = new Map([...target, ["0060_next.sql", "nextest-blob"]]);
    const admitted = admitOrdinarySchemaRelease({ changedPaths: schemaPaths, baseMigrationBlobs: base, targetMigrationBlobs: orderedTarget });
    expect(admitted.newMigrations).toEqual(["0059_next.sql", "0060_next.sql"]);
    expect(admitted.targetMigrationExpectation).toMatch(/^inventory-sha256:[a-f0-9]{64}$/);
  });

  it.each([
    ["PRE_CAS", "b".repeat(40), { sales_paused: false }, { complete: false }, "PRE_CAS"],
    ["POST_CAS_RESUME while runtime remains base", "a".repeat(40), { sales_paused: true, owner_release_id: `deploy-${"a".repeat(40)}`, owner_mode: "CONTROLLED_CUTOVER", expected: { source_commit: "a".repeat(40), migration: `inventory-sha256:${"c".repeat(64)}` } }, { complete: false }, "POST_CAS_RESUME"],
    ["foreign production pointer", "d".repeat(40), { sales_paused: false }, { complete: false }, "ORDINARY_SCHEMA_DEPLOY_POINTER_STATE_INVALID"],
    ["POST_CAS invalid owner", "a".repeat(40), { sales_paused: true, owner_release_id: "other", owner_mode: "CONTROLLED_CUTOVER", expected: { source_commit: "a".repeat(40), migration: `inventory-sha256:${"c".repeat(64)}` } }, { complete: false }, "ORDINARY_SCHEMA_POST_CAS_OWNER_STATE_INVALID"],
    ["POST_CAS expectation mismatch", "a".repeat(40), { sales_paused: true, owner_release_id: `deploy-${"a".repeat(40)}`, owner_mode: "CONTROLLED_CUTOVER", expected: { source_commit: "a".repeat(40), migration: `inventory-sha256:${"d".repeat(64)}` } }, { complete: false }, "ORDINARY_SCHEMA_POST_CAS_OWNER_STATE_INVALID"],
  ])("classifies %s", (_label, productionDeploySha, durable, completion, expected) => {
    const input = { productionDeploySha, originalBaseSha: "b".repeat(40), targetSha: "a".repeat(40), targetMigrationExpectation: `inventory-sha256:${"c".repeat(64)}`, durable, completion };
    if (expected.startsWith("ORDINARY_")) expect(() => classifyOrdinarySchemaDeployState(input)).toThrow(expected);
    else expect(classifyOrdinarySchemaDeployState(input)).toBe(expected);
  });
});
