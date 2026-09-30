import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { classifyV2Database } from "./db";

type Catalogue = {
  readonly cities: ReadonlyArray<{ readonly slug: string; readonly title: string }>;
  readonly products: ReadonlyArray<{
    readonly productRef: string;
    readonly kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
    readonly accessModel: "FREE" | "PAID";
    readonly courseRef?: string;
    readonly offerRef: string;
    readonly priceKopecks: number;
    readonly saleMode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  }>;
  readonly labOccurrences: ReadonlyArray<{
    readonly occurrenceRef: string;
    readonly citySlug: string;
    readonly title: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timezone: string;
    readonly capacity: number;
  }>;
};

export class V2SeedError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const readV2Catalogue = (path = join(process.cwd(), "commerce-v2", "launch", "catalog.json")) =>
  JSON.parse(readFileSync(path, "utf8")) as Catalogue;

export const v2CatalogueDigest = (catalogue: Catalogue) =>
  createHash("sha256").update(JSON.stringify(catalogue)).digest("hex");

export function applyV2Seed(db: Database.Database, catalogue: Catalogue) {
  if (classifyV2Database(db) !== "SUPPORTED") throw new V2SeedError("V2_SEED_UNSUPPORTED_LINEAGE");
  const digest = v2CatalogueDigest(catalogue);
  const seed = db.transaction(() => {
    const existing = db.prepare("SELECT catalogue_sha256 FROM launch_seed WHERE singleton = 1").get() as { catalogue_sha256: string } | undefined;
    if (existing) {
      if (existing.catalogue_sha256 === digest) return { kind: "ALREADY_APPLIED", digest } as const;
      throw new V2SeedError("V2_SEED_CATALOGUE_MISMATCH");
    }

    const cityBySlug = new Map<string, string>();
    const insertCity = db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)");
    for (const city of catalogue.cities) {
      const id = randomUUID();
      insertCity.run(id, city.slug, city.title);
      cityBySlug.set(city.slug, id);
    }

    const insertProduct = db.prepare(`INSERT INTO products
      (id, product_ref, kind, access_model, course_ref) VALUES (?, ?, ?, ?, ?)`);
    const insertOffer = db.prepare(`INSERT INTO offers
      (id, offer_ref, product_id, price_kopecks, sale_mode) VALUES (?, ?, ?, ?, ?)`);
    for (const product of catalogue.products) {
      const id = randomUUID();
      insertProduct.run(id, product.productRef, product.kind, product.accessModel, product.courseRef ?? null);
      insertOffer.run(randomUUID(), product.offerRef, id, product.priceKopecks, product.saleMode);
    }

    const insertOccurrence = db.prepare(`INSERT INTO lab_occurrences
      (id, occurrence_ref, city_id, title, starts_at, ends_at, timezone, capacity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const occurrence of catalogue.labOccurrences) {
      const cityId = cityBySlug.get(occurrence.citySlug);
      if (!cityId) throw new V2SeedError("V2_SEED_UNKNOWN_CITY");
      insertOccurrence.run(randomUUID(), occurrence.occurrenceRef, cityId, occurrence.title,
        occurrence.startsAt, occurrence.endsAt, occurrence.timezone, occurrence.capacity);
    }

    db.prepare("INSERT INTO launch_seed(singleton, catalogue_sha256) VALUES (1, ?)").run(digest);
    return { kind: "APPLIED", digest } as const;
  });
  return seed.immediate();
}
