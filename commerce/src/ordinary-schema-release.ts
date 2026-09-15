import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { genericProductionDeployBoundary, releaseSemanticsCategories } from "./generic-production-deploy-boundary";
import { isMigrationFilenameExpectation, migrationInventoryExpectation } from "./release-expectation";

export type OrdinarySchemaAdmission = {
  readonly targetMigrationExpectation: string;
  readonly newMigrations: readonly string[];
};

const fail = (code: string): never => { throw new Error(code); };

const assertMigrationFilename = (filename: string): void => {
  if (!isMigrationFilenameExpectation(filename)) fail(`ORDINARY_SCHEMA_MIGRATION_FILENAME_INVALID=${filename}`);
};

export type OrdinarySchemaDeployState = "PRE_CAS" | "POST_CAS_RESUME";

/**
 * The schema workflow has exactly two authorities: before the guarded pointer
 * CAS, or an incomplete same-owner release which has already crossed it. This
 * is classification of existing durable state, not a second state machine.
 */
export const classifyOrdinarySchemaDeployState = (input: {
  readonly productionDeploySha: string;
  readonly originalBaseSha: string;
  readonly targetSha: string;
  readonly targetMigrationExpectation: string;
  readonly durable: {
    readonly sales_paused?: unknown;
    readonly owner_release_id?: unknown;
    readonly owner_mode?: unknown;
    readonly expected?: { readonly source_commit?: unknown; readonly migration?: unknown };
  };
  readonly completion: { readonly complete?: unknown };
}): OrdinarySchemaDeployState => {
  if (input.productionDeploySha === input.originalBaseSha) return "PRE_CAS";
  if (input.productionDeploySha !== input.targetSha) fail("ORDINARY_SCHEMA_DEPLOY_POINTER_STATE_INVALID");
  const expected = input.durable.expected;
  if (
    input.completion.complete !== false ||
    input.durable.sales_paused !== true ||
    input.durable.owner_release_id !== `deploy-${input.targetSha}` ||
    input.durable.owner_mode !== "CONTROLLED_CUTOVER" ||
    expected?.source_commit !== input.targetSha ||
    expected.migration !== input.targetMigrationExpectation
  ) fail("ORDINARY_SCHEMA_POST_CAS_OWNER_STATE_INVALID");
  return "POST_CAS_RESUME";
};

/**
 * The only admission widened for the ordinary schema lane. It is deliberately
 * stricter than "generic deploy with ALLOW_SCHEMA": the diff must be exactly
 * a schema crossing, with no legal or release-semantic authority change, and
 * migration history is append-only at the blob level.
 */
export const admitOrdinarySchemaRelease = (input: {
  readonly changedPaths: readonly string[];
  readonly baseMigrationBlobs: ReadonlyMap<string, string>;
  readonly targetMigrationBlobs: ReadonlyMap<string, string>;
}): OrdinarySchemaAdmission => {
  if (genericProductionDeployBoundary(input.changedPaths) !== "SCHEMA") fail("ORDINARY_SCHEMA_BOUNDARY_NOT_SCHEMA");
  if (input.changedPaths.some((path) => path.startsWith("public/legal/") || path.startsWith("commerce/legal/"))) fail("ORDINARY_SCHEMA_LEGAL_CHANGED");
  if (input.changedPaths.includes("release-surface-contract.json")) fail("ORDINARY_SCHEMA_SURFACE_CONTRACT_CHANGED");
  const categories = releaseSemanticsCategories(input.changedPaths);
  if (categories.length) fail(`ORDINARY_SCHEMA_RELEASE_SEMANTICS_CHANGED=${categories.join(",")}`);

  for (const [filename, blob] of input.baseMigrationBlobs) {
    assertMigrationFilename(filename);
    const targetBlob = input.targetMigrationBlobs.get(filename);
    if (!targetBlob) fail(`ORDINARY_SCHEMA_HISTORICAL_MIGRATION_MISSING=${filename}`);
    if (targetBlob !== blob) fail(`ORDINARY_SCHEMA_HISTORICAL_MIGRATION_CHANGED=${filename}`);
  }
  const newMigrations = [...input.targetMigrationBlobs.keys()].filter((filename) => !input.baseMigrationBlobs.has(filename)).sort();
  if (!newMigrations.length) fail("ORDINARY_SCHEMA_NO_NEW_MIGRATIONS");
  for (const filename of newMigrations) assertMigrationFilename(filename);
  const baseTail = [...input.baseMigrationBlobs.keys()].sort().at(-1);
  if (baseTail && newMigrations[0] <= baseTail) fail(`ORDINARY_SCHEMA_MIGRATION_ORDER_INVALID=${newMigrations[0]}`);
  return {
    targetMigrationExpectation: migrationInventoryExpectation([...input.targetMigrationBlobs.keys()]),
    newMigrations,
  };
};

const migrationBlobsAt = (sha: string): Map<string, string> => {
  const lines = execFileSync("git", ["ls-tree", "-r", sha, "--", "commerce/migrations"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return new Map(lines.map((line) => {
    const match = /^\d+ blob ([0-9a-f]{40})\tcommerce\/migrations\/(.+\.sql)$/.exec(line);
    const [, blob, filename] = match ?? fail(`ORDINARY_SCHEMA_MIGRATION_TREE_INVALID=${line}`);
    return [filename, blob];
  }));
};

/** CLI seam used by both publication and deployment adapters. */
if (process.argv[1]?.endsWith("ordinary-schema-release.ts")) {
  const [base, target] = process.argv.slice(2);
  if (base === "target-expectation") {
    const targetMigrationBlobs = migrationBlobsAt(target ?? "");
    for (const filename of targetMigrationBlobs.keys()) assertMigrationFilename(filename);
    process.stdout.write(`${migrationInventoryExpectation([...targetMigrationBlobs.keys()])}\n`);
    process.exit(0);
  }
  if (base === "classify-deploy-state") {
    const [originalBaseSha, targetSha, targetMigrationExpectation, durablePath, completionPath] = process.argv.slice(3);
    if (!originalBaseSha || !targetSha || !targetMigrationExpectation || !durablePath || !completionPath) fail("ORDINARY_SCHEMA_DEPLOY_STATE_INPUT_INVALID");
    const productionDeploySha = execFileSync("git", ["rev-parse", "origin/production-deploy"], { encoding: "utf8" }).trim();
    const state = classifyOrdinarySchemaDeployState({
      productionDeploySha,
      originalBaseSha,
      targetSha,
      targetMigrationExpectation,
      durable: JSON.parse(readFileSync(durablePath, "utf8")),
      completion: JSON.parse(readFileSync(completionPath, "utf8")),
    });
    process.stdout.write(`${state}\n`);
    process.exit(0);
  }
  if (!base || !target) fail("Pass base and target commit SHAs.");
  const changedPaths = execFileSync("git", ["diff", "--name-only", base, target], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const admission = admitOrdinarySchemaRelease({ changedPaths, baseMigrationBlobs: migrationBlobsAt(base), targetMigrationBlobs: migrationBlobsAt(target) });
  process.stdout.write(`${JSON.stringify(admission)}\n`);
}
