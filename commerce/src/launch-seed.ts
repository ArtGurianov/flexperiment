import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { classifySchemaLineage } from "./release/schema-identity";
import { readSchemaIdentity } from "./db";

/**
 * The catalogue a fresh launch database starts with, and nothing else.
 *
 * What belongs here is content: cities, and the occurrences that are really
 * scheduled. What does not is the schema's own zero state - the singletons, the
 * advertising policies, the feature state - because those are what make a
 * database trustworthy in the first place and the baseline creates them. The
 * legal release is not here either: it is republished through
 * `commerce:legal-release:publish`, so the publication ledger is real rather
 * than manufactured by an INSERT.
 *
 * `promo_codes` and `partners` are deliberately absent. Promo codes were only
 * ever test codes, and no partner has registered.
 */

export type LaunchCatalogue = {
  readonly cities: ReadonlyArray<{ readonly slug: string; readonly title: string }>;
  readonly occurrences: ReadonlyArray<Record<string, unknown>>;
};

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
  if (!Array.isArray(parsed.cities) || !Array.isArray(parsed.occurrences)) throw new LaunchSeedError("LAUNCH_CATALOGUE_MALFORMED", path);
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
export const applyLaunchSeed = (db: Database.Database, catalogue: LaunchCatalogue): { citiesInserted: number } => {
  const lineage = classifySchemaLineage(readSchemaIdentity(db));
  if (lineage !== "SUPPORTED") throw new LaunchSeedError("LAUNCH_SEED_UNSUPPORTED_LINEAGE", lineage);

  // A seed that seeds nothing and records that it ran would block the real one
  // forever, and the marker is write-once by design.
  if (!catalogue.cities.length) throw new LaunchSeedError("LAUNCH_CATALOGUE_EMPTY");

  const run = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM launch_seed WHERE singleton = 1").get()) throw new LaunchSeedError("LAUNCH_SEED_ALREADY_APPLIED");
    for (const table of ["cities", "occurrences"]) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      if (n > 0) throw new LaunchSeedError("LAUNCH_SEED_TARGET_NOT_EMPTY", table);
    }

    const insertCity = db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)");
    for (const city of catalogue.cities) insertCity.run(randomUUID(), city.slug, city.title);
    // Occurrences are content an operator schedules, not something this file
    // invents. An empty list is a legitimate launch state; the catalogue simply
    // says so out loud rather than leaving it implied.
    if (catalogue.occurrences.length) throw new LaunchSeedError("LAUNCH_SEED_OCCURRENCES_UNSUPPORTED", `${catalogue.occurrences.length}`);

    db.prepare("INSERT INTO launch_seed(singleton, catalogue_sha256) VALUES (1, ?)").run(catalogueDigest(catalogue));
    return { citiesInserted: catalogue.cities.length };
  });
  return db.inTransaction ? run() : run.immediate();
};
