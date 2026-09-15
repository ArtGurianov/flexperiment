import { execFileSync } from "node:child_process";
import { genericProductionDeployBoundary, releaseSemanticsCategories } from "./generic-production-deploy-boundary";
import { migrationInventoryExpectation } from "./release-expectation";

export type OrdinarySchemaAdmission = {
  readonly targetMigrationExpectation: string;
  readonly newMigrations: readonly string[];
};

const fail = (code: string): never => { throw new Error(code); };

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
    const targetBlob = input.targetMigrationBlobs.get(filename);
    if (!targetBlob) fail(`ORDINARY_SCHEMA_HISTORICAL_MIGRATION_MISSING=${filename}`);
    if (targetBlob !== blob) fail(`ORDINARY_SCHEMA_HISTORICAL_MIGRATION_CHANGED=${filename}`);
  }
  const newMigrations = [...input.targetMigrationBlobs.keys()].filter((filename) => !input.baseMigrationBlobs.has(filename)).sort();
  if (!newMigrations.length) fail("ORDINARY_SCHEMA_NO_NEW_MIGRATIONS");
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
  if (!base || !target) fail("Pass base and target commit SHAs.");
  const changedPaths = execFileSync("git", ["diff", "--name-only", base, target], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const admission = admitOrdinarySchemaRelease({ changedPaths, baseMigrationBlobs: migrationBlobsAt(base), targetMigrationBlobs: migrationBlobsAt(target) });
  process.stdout.write(`${JSON.stringify(admission)}\n`);
}
