import { readFileSync, writeFileSync } from "node:fs";

/**
 * One-shot, hard-bound schema-compatibility adapter for exactly one known,
 * verified R5 defect (see the 2026-08-28 R7 fix and DEPLOYMENT_INVARIANTS.md):
 * evaluateReopenGate() on R5 cannot recognize 0035/0036 as applied via
 * required_migrations alone, because releaseRuntimeEvidence() has never
 * populated required_migrations with keys beyond the fixed
 * diagnosticCutoverMigrations set (0031-0034), on any commit, old or new -
 * migration_versions (the complete applied-migration inventory, unaffected
 * by this) has always correctly listed 0035/0036 as applied. R7 fixes the
 * evaluator; R5 itself is not being patched, and per the runtime-pinning
 * invariant the submit preflight must judge R5's evidence using R5's own
 * (unfixed) code - so this adapter fills in exactly the two missing keys a
 * correct evaluator would have derived from migration_versions itself,
 * and nothing else.
 *
 * This does not duplicate evaluateReopenGate()'s logic, does not touch
 * production, and is not a general-purpose evidence editor: it fails
 * closed unless the input status JSON matches this exact known defect
 * pattern (exact R5 as both the owner's expected.source_commit and the
 * running runtime.source_commit, expected.migration exactly 0036, the four
 * diagnostic migrations already true, 0035/0036 present in
 * migration_versions but structurally absent as required_migrations keys),
 * and proves the derived copy differs from the original in no way other
 * than those two added keys before writing it.
 */

const EXPECTED_SOURCE_COMMIT = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1"; // exact R5
const EXPECTED_MIGRATION = "0036_tochka_provider_error_evidence.sql";
const PREREQUISITE_MIGRATION = "0035_promo_codes_v0.sql";
const DIAGNOSTIC_MIGRATIONS = ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"];

type StatusWithRuntime = {
  expected: {
    source_commit: string;
    migration: string;
  };
  runtime: {
    source_commit: string;
    required_migrations: Record<string, boolean>;
    migration_versions: string[];
  };
};

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Pass the input status JSON path and the output compatibility-copy path.");

const original = JSON.parse(readFileSync(inputPath, "utf8")) as StatusWithRuntime;

// This adapter is hard-bound to exactly one owner expectation - R5 runtime,
// expecting migration 0036 - not merely to the runtime source_commit. The
// workflow call-site already proves this immediately before invoking the
// adapter, but the adapter is itself a named safety primitive that claims
// to be a hard-bound R5/0036 one-shot bridge, so it must enforce its own
// contract rather than relying on an adjacent caller guard.
if (original.expected.source_commit !== EXPECTED_SOURCE_COMMIT) {
  console.error(`R5_COMPAT_EXPECTED_SOURCE_COMMIT_MISMATCH: expected ${EXPECTED_SOURCE_COMMIT}, got ${original.expected.source_commit}`);
  process.exit(1);
}
if (original.expected.migration !== EXPECTED_MIGRATION) {
  console.error(`R5_COMPAT_EXPECTED_MIGRATION_MISMATCH: expected ${EXPECTED_MIGRATION}, got ${original.expected.migration}`);
  process.exit(1);
}
if (original.runtime.source_commit !== EXPECTED_SOURCE_COMMIT) {
  console.error(`R5_COMPAT_SOURCE_COMMIT_MISMATCH: expected ${EXPECTED_SOURCE_COMMIT}, got ${original.runtime.source_commit}`);
  process.exit(1);
}
for (const version of DIAGNOSTIC_MIGRATIONS) {
  if (original.runtime.required_migrations[version] !== true) {
    console.error(`R5_COMPAT_DIAGNOSTIC_MIGRATION_NOT_APPLIED: ${version}`);
    process.exit(1);
  }
}
if (!original.runtime.migration_versions.includes(PREREQUISITE_MIGRATION)) {
  console.error(`R5_COMPAT_PREREQUISITE_MIGRATION_MISSING: ${PREREQUISITE_MIGRATION}`);
  process.exit(1);
}
if (!original.runtime.migration_versions.includes(EXPECTED_MIGRATION)) {
  console.error(`R5_COMPAT_EXPECTED_MIGRATION_MISSING: ${EXPECTED_MIGRATION}`);
  process.exit(1);
}
// The exact known defect pattern requires these two keys to currently be
// absent from required_migrations - if either is already present, this is
// not the known defect and this adapter must not pretend to bridge it.
if (original.runtime.required_migrations[PREREQUISITE_MIGRATION] !== undefined) {
  console.error(`R5_COMPAT_UNEXPECTED_PREREQUISITE_KEY_PRESENT: ${PREREQUISITE_MIGRATION}`);
  process.exit(1);
}
if (original.runtime.required_migrations[EXPECTED_MIGRATION] !== undefined) {
  console.error(`R5_COMPAT_UNEXPECTED_EXPECTED_KEY_PRESENT: ${EXPECTED_MIGRATION}`);
  process.exit(1);
}

const derived = {
  ...original,
  runtime: {
    ...original.runtime,
    required_migrations: {
      ...original.runtime.required_migrations,
      [PREREQUISITE_MIGRATION]: true,
      [EXPECTED_MIGRATION]: true,
    },
  },
};

// Prove the only difference from the original is exactly those two added
// keys: remove them from the derived copy and require byte-identical JSON
// against the original.
const { [PREREQUISITE_MIGRATION]: _prerequisiteKeyRemoved, [EXPECTED_MIGRATION]: _expectedKeyRemoved, ...requiredMigrationsWithoutTheTwoKeys } = derived.runtime.required_migrations;
const derivedForComparison = { ...derived, runtime: { ...derived.runtime, required_migrations: requiredMigrationsWithoutTheTwoKeys } };
if (JSON.stringify(derivedForComparison) !== JSON.stringify(original)) {
  console.error("R5_COMPAT_UNEXPECTED_DIFFERENCE");
  process.exit(1);
}

writeFileSync(outputPath, JSON.stringify(derived));
