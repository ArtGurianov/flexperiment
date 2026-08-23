import { randomUUID } from "node:crypto";
import { migrate, openDatabase } from "./db";
import { CITY_CATALOGUE } from "../../lib/city-catalog";

if (process.env.COMMERCE_SEED_DEVELOPMENT !== "true") {
  throw new Error("Refusing to seed commerce data. Set COMMERCE_SEED_DEVELOPMENT=true for a disposable development database.");
}

const sqlite = openDatabase(); migrate(sqlite);
const insert = sqlite.prepare("INSERT OR IGNORE INTO cities(id, slug, title) VALUES (?, ?, ?)");
for (const city of CITY_CATALOGUE) insert.run(randomUUID(), city.slug, city.title);
const active = sqlite.prepare("SELECT id FROM legal_releases WHERE active = 1").get();
const developmentLegalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "development-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };
if (!active) sqlite.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'development-1', datetime('now'), ?, 1)").run(randomUUID(), JSON.stringify(developmentLegalManifest));
sqlite.close();
console.log("Development-only city and legal-release seed complete.");
