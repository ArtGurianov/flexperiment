import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db";
import { applyLaunchSeed, catalogueDigest, readLaunchCatalogue, LaunchSeedError, type LaunchCatalogue } from "../src/launch-seed";

const catalogue: LaunchCatalogue = {
  cities: [{ slug: "moscow", title: "Москва" }, { slug: "kazan", title: "Казань" }],
  occurrences: [],
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
});

const cityCount = () => (db.prepare("SELECT COUNT(*) AS n FROM cities").get() as { n: number }).n;

describe("the launch seed", () => {
  it("seeds the catalogue into a fresh launch database", () => {
    expect(applyLaunchSeed(db, catalogue)).toEqual({ citiesInserted: 2 });
    expect(db.prepare("SELECT slug FROM cities ORDER BY slug").all()).toEqual([{ slug: "kazan" }, { slug: "moscow" }]);
    expect(db.prepare("SELECT catalogue_sha256 FROM launch_seed WHERE singleton = 1").get())
      .toEqual({ catalogue_sha256: catalogueDigest(catalogue) });
  });

  it("refuses to run twice, even after the catalogue it wrote was edited", () => {
    // The marker answers "has this been seeded", which is a different question
    // from "are the tables empty" - a city retired later must not come back.
    applyLaunchSeed(db, catalogue);
    db.prepare("DELETE FROM cities WHERE slug = 'kazan'").run();

    expect(() => applyLaunchSeed(db, catalogue)).toThrow("LAUNCH_SEED_ALREADY_APPLIED");
    expect(cityCount()).toBe(1);
  });

  it("refuses a database that already has content the seed would talk over", () => {
    db.prepare("INSERT INTO cities(id, slug, title) VALUES ('existing', 'sochi', 'Сочи')").run();
    expect(() => applyLaunchSeed(db, catalogue)).toThrow("LAUNCH_SEED_TARGET_NOT_EMPTY: cities");
    expect(cityCount()).toBe(1);
  });

  it("refuses any database that is not a launch database", () => {
    const legacy = new Database(":memory:");
    legacy.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    legacy.exec("CREATE TABLE cities (id TEXT PRIMARY KEY, slug TEXT, title TEXT)");
    legacy.prepare("INSERT INTO schema_migrations(version) VALUES ('0001_initial.sql')").run();

    expect(() => applyLaunchSeed(legacy, catalogue)).toThrow("LAUNCH_SEED_UNSUPPORTED_LINEAGE: LEGACY");
  });

  it("leaves nothing behind when a city cannot be written", () => {
    // Half a catalogue and no marker is indistinguishable from never having run.
    const duplicated: LaunchCatalogue = { cities: [...catalogue.cities, { slug: "moscow", title: "Москва снова" }], occurrences: [] };
    expect(() => applyLaunchSeed(db, duplicated)).toThrow();
    expect(cityCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM launch_seed").get()).toEqual({ n: 0 });
  });

  it("does not seed what is not content", () => {
    // The zero state belongs to the baseline, and the legal release is
    // republished so its ledger is real. Neither is this file's to write.
    applyLaunchSeed(db, catalogue);
    expect(db.prepare("SELECT COUNT(*) AS n FROM promo_codes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM partners").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM legal_releases").get()).toEqual({ n: 0 });
    // ...and the things the baseline does own are already there.
    expect(db.prepare("SELECT state FROM agent_referrals_feature_state").get()).toEqual({ state: "ACTIVE" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ad_channel_policy").get()).toEqual({ n: 9 });
  });

  it("refuses to erase or rewrite the record that it ran", () => {
    applyLaunchSeed(db, catalogue);
    expect(() => db.exec("UPDATE launch_seed SET catalogue_sha256 = '" + "f".repeat(64) + "' WHERE singleton = 1")).toThrow("LAUNCH_SEED_IMMUTABLE");
    expect(() => db.exec("DELETE FROM launch_seed WHERE singleton = 1")).toThrow("LAUNCH_SEED_IMMUTABLE");
  });

  it("reads the committed catalogue and finds it usable", () => {
    const committed = readLaunchCatalogue();
    expect(committed.cities.length).toBeGreaterThan(0);
    expect(applyLaunchSeed(db, committed)).toEqual({ citiesInserted: committed.cities.length });
  });

  it("refuses a catalogue that cannot be trusted, without consuming the one chance to seed", () => {
    // The marker is write-once, so a seed that wrote nothing but recorded
    // itself would leave the real catalogue with nowhere to go.
    expect(() => applyLaunchSeed(db, { cities: [], occurrences: [] })).toThrow("LAUNCH_CATALOGUE_EMPTY");
    expect(() => applyLaunchSeed(db, { cities: [{ slug: "x", title: "X" }], occurrences: [{}] }))
      .toThrow("LAUNCH_SEED_OCCURRENCES_UNSUPPORTED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM launch_seed").get()).toEqual({ n: 0 });
    expect(applyLaunchSeed(db, catalogue)).toEqual({ citiesInserted: 2 });
  });
});

describe("the committed catalogue", () => {
  it("is well formed", () => {
    const committed = readLaunchCatalogue();
    expect(new Set(committed.cities.map((city) => city.slug)).size).toBe(committed.cities.length);
    for (const city of committed.cities) {
      expect(city.slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(city.title.trim()).not.toBe("");
    }
  });
});
