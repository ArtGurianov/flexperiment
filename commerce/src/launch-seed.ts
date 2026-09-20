import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { classifySchemaLineage } from "./release/schema-identity";
import { readSchemaIdentity } from "./db";

/**
 * The catalogue a fresh launch database starts with, and nothing else.
 *
 * What belongs here is the city reference data, and nothing else. The schema's
 * own zero state - the singletons, the advertising policies, the feature state
 * - is the baseline's, because those are what make a database trustworthy in
 * the first place. The legal release is republished through
 * `commerce:legal-release:publish`, so its publication ledger is real rather
 * than manufactured by an INSERT.
 *
 * **Occurrences are not seeded, and the format has no field for them.** They
 * are created and published by an operator through the admin surface, which is
 * also how the certification occurrence comes to exist - see the cutover
 * sequence in DEPLOYMENT_INVARIANTS.md. A field that was only ever allowed to
 * be empty would be a contract this file does not keep.
 *
 * `promo_codes` and `partners` are deliberately absent. Promo codes were only
 * ever test codes, and no partner has registered.
 */

export type LaunchCatalogue = {
  readonly cities: ReadonlyArray<{ readonly slug: string; readonly title: string }>;
};

/**
 * What a seed did, as an answer a cutover orchestrator can act on.
 *
 * `ALREADY_APPLIED_SAME_CATALOGUE` is a success, not a refusal. A runner whose
 * transaction committed and whose response was lost has to be able to repeat
 * the command and learn that it succeeded - otherwise a retry is
 * indistinguishable from an attempt to seed a different catalogue, and the
 * operator is left guessing which of the two happened.
 */
export type LaunchSeedOutcome =
  | { readonly kind: "APPLIED"; readonly citiesInserted: number; readonly catalogueSha256: string }
  | { readonly kind: "ALREADY_APPLIED_SAME_CATALOGUE"; readonly catalogueSha256: string };

export class LaunchSeedError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export const catalogueDigest = (catalogue: LaunchCatalogue): string =>
  createHash("sha256").update(JSON.stringify(catalogue)).digest("hex");

export const readLaunchCatalogue = (
  path = join(process.cwd(), "commerce", "launch", "catalog.json"),
): LaunchCatalogue => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as LaunchCatalogue;
  if (!Array.isArray(parsed.cities)) throw new LaunchSeedError("LAUNCH_CATALOGUE_MALFORMED", path);
  if (!parsed.cities.length) throw new LaunchSeedError("LAUNCH_CATALOGUE_EMPTY", path);
  const slugs = new Set(parsed.cities.map((city) => city.slug));
  if (slugs.size !== parsed.cities.length) throw new LaunchSeedError("LAUNCH_CATALOGUE_DUPLICATE_CITY");
  for (const city of parsed.cities) {
    if (!city.slug?.trim() || !city.title?.trim()) throw new LaunchSeedError("LAUNCH_CATALOGUE_CITY_INCOMPLETE", city.slug ?? "");
  }
  return parsed;
};

/**
 * Three preconditions, and each answers a different question.
 *
 * Lineage asks whether this is a database this build may write to at all.
 * The marker asks whether seeding has already happened - which is not the same
 * as whether the tables have rows, because a city retired later would otherwise
 * make the seed resurrect it. Emptiness asks whether anything is already there
 * that this seed would be talking over.
 *
 * All of it, and the write, in one transaction: a seed that failed halfway and
 * left no marker would be indistinguishable from one that never ran.
 */
export const applyLaunchSeed = (db: Database.Database, catalogue: LaunchCatalogue): LaunchSeedOutcome => {
  const lineage = classifySchemaLineage(readSchemaIdentity(db));
  if (lineage !== "SUPPORTED") throw new LaunchSeedError("LAUNCH_SEED_UNSUPPORTED_LINEAGE", lineage);

  // A seed that seeds nothing and records that it ran would block the real one
  // forever, and the marker is write-once by design.
  if (!catalogue.cities.length) throw new LaunchSeedError("LAUNCH_CATALOGUE_EMPTY");

  const requested = catalogueDigest(catalogue);
  const run = db.transaction(() => {
    // Read inside the write lock, so the marker this decision is made from is
    // the marker that is still there when the decision is written.
    const marker = db.prepare("SELECT catalogue_sha256 FROM launch_seed WHERE singleton = 1")
      .get() as { catalogue_sha256: string } | undefined;
    if (marker) {
      // A committed seed whose response was lost, repeated: the same catalogue
      // already ran, so the command succeeded and there is nothing to do.
      if (marker.catalogue_sha256 === requested) {
        return { kind: "ALREADY_APPLIED_SAME_CATALOGUE", catalogueSha256: requested } as const;
      }
      // A different catalogue is not a retry. Fail closed and say which two.
      throw new LaunchSeedError("LAUNCH_SEED_CATALOGUE_MISMATCH", `${marker.catalogue_sha256} != ${requested}`);
    }

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM cities").get() as { n: number };
    if (n > 0) throw new LaunchSeedError("LAUNCH_SEED_TARGET_NOT_EMPTY", "cities");

    const insertCity = db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)");
    for (const city of catalogue.cities) insertCity.run(randomUUID(), city.slug, city.title);
    db.prepare("INSERT INTO launch_seed(singleton, catalogue_sha256) VALUES (1, ?)").run(requested);
    return { kind: "APPLIED", citiesInserted: catalogue.cities.length, catalogueSha256: requested } as const;
  });
  // `immediate()` takes the write lock before anything is read, so the marker
  // check and the write it decides cannot be separated by another runner.
  return db.inTransaction ? run() : run.immediate();
};
