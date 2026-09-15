import { readFileSync } from "node:fs";

import { findSnapshotDefects, judgeOccurrence } from "../../lib/seo/occurrence-publication";
import { readSnapshotFile, serializeSnapshot, SNAPSHOT_PATH } from "./seo-snapshot-io";

/**
 * Validates the committed snapshot on its own terms.
 *
 *   --snapshot <file>  default: data/seo/occurrences.v1.json
 *
 * Snapshot VALIDITY is a hard failure: a malformed or self-contradictory
 * artifact must never reach a build, because every page generated from it
 * asserts commercial facts.
 *
 * What this deliberately does NOT do is contact Commerce. Production-versus-
 * snapshot drift is a real thing to watch, but it is an operational check on
 * its own schedule, not a build-reproducibility gate: wiring it in here would
 * turn an unrelated frontend pull request red the moment an operator edits a
 * date, which trains everyone to ignore the signal. See
 * docs/release/SEO_SURFACE_SNAPSHOT.md.
 */
const parseArguments = (argv: readonly string[]): { snapshot: string } => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !value || name !== "--snapshot" || values.has(name)) {
      throw new Error("SEO_SNAPSHOT_VALIDATE_ARGUMENTS_INVALID");
    }
    values.set(name, value);
  }
  return { snapshot: values.get("--snapshot") ?? SNAPSHOT_PATH };
};

try {
  const args = parseArguments(process.argv.slice(2));
  const snapshot = readSnapshotFile(args.snapshot);

  const defects = findSnapshotDefects(snapshot);
  for (const defect of defects) {
    process.stderr.write(`SEO_SNAPSHOT_DEFECT ${defect.code} ${defect.detail}\n`);
  }
  if (defects.length > 0) throw new Error("SEO_SNAPSHOT_DEFECTIVE");

  // Canonical bytes are part of validity, not a formatting preference: a
  // hand-edited file that happens to parse but is not canonically serialized
  // would make every regeneration produce a spurious diff.
  const roundTrip = serializeSnapshot(snapshot);
  if (readFileSync(args.snapshot, "utf8") !== roundTrip) throw new Error("SEO_SNAPSHOT_NOT_CANONICAL");

  const withheld = snapshot.occurrences.filter(
    (entry) => judgeOccurrence(entry).outcome === "NOT_SCHEMA_ELIGIBLE",
  );
  process.stdout.write(
    `${args.snapshot}: ${snapshot.occurrences.length} occurrence(s), ` +
      `${snapshot.tombstones.length} tombstone(s), ` +
      `${withheld.length} without Event structured data\n`,
  );
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
