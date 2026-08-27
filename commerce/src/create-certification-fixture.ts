import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { MockProvider } from "./provider";

const EXECUTE_CONFIRM = "CREATE-CERTIFICATION-FIXTURE";
const REPLACE_KEY_CONFIRM = "REPLACE-EXISTING-KEY";

const databasePath = process.env.COMMERCE_DATABASE_PATH;
const label = process.env.COMMERCE_CERTIFICATION_FIXTURE_LABEL;
const cityId = process.env.COMMERCE_CERTIFICATION_FIXTURE_CITY_ID;
const startsAt = process.env.COMMERCE_CERTIFICATION_FIXTURE_STARTS_AT;
const endsAt = process.env.COMMERCE_CERTIFICATION_FIXTURE_ENDS_AT;
const keyPath = process.env.COMMERCE_CERTIFICATION_FIXTURE_KEY_PATH;
const manifestPath = process.env.COMMERCE_CERTIFICATION_FIXTURE_MANIFEST_PATH;
const execute = process.env.COMMERCE_CERTIFICATION_FIXTURE_EXECUTE === EXECUTE_CONFIRM;
const replaceKey = process.env.COMMERCE_CERTIFICATION_FIXTURE_REPLACE_KEY === REPLACE_KEY_CONFIRM;

if (!databasePath || !existsSync(resolve(databasePath))) {
  throw new Error("COMMERCE_DATABASE_PATH must name the existing SQLite database.");
}
if (!label) {
  throw new Error("COMMERCE_CERTIFICATION_FIXTURE_LABEL must name this fixture run, e.g. gen6-R4-certification-fixture.");
}
if (!cityId) {
  throw new Error("COMMERCE_CERTIFICATION_FIXTURE_CITY_ID must name an existing city row for this fixture.");
}
if (!startsAt || !endsAt || Date.parse(startsAt) >= Date.parse(endsAt)) {
  throw new Error("COMMERCE_CERTIFICATION_FIXTURE_STARTS_AT and _ENDS_AT must be ISO timestamps with starts_at before ends_at.");
}
if (!keyPath) {
  throw new Error("COMMERCE_CERTIFICATION_FIXTURE_KEY_PATH must name where the raw checkout idempotency key is written.");
}
if (!manifestPath) {
  throw new Error("COMMERCE_CERTIFICATION_FIXTURE_MANIFEST_PATH must name where the run manifest is written.");
}

const venueAnnounceBy = process.env.COMMERCE_CERTIFICATION_FIXTURE_VENUE_ANNOUNCE_BY
  ?? new Date(Date.parse(startsAt) - 24 * 60 * 60 * 1000).toISOString();
if (Date.parse(venueAnnounceBy) >= Date.parse(startsAt)) {
  throw new Error("COMMERCE_CERTIFICATION_FIXTURE_VENUE_ANNOUNCE_BY must be before COMMERCE_CERTIFICATION_FIXTURE_STARTS_AT.");
}

const occurrenceInput = {
  city_id: cityId,
  title: `FLEXPERIMENT — ${label}`,
  starts_at: startsAt,
  ends_at: endsAt,
  timezone: "Europe/Moscow",
  price_kopecks: 101,
  capacity: 1,
  venue_status: "TO_BE_ANNOUNCED" as const,
  venue_disclosure_text: "Venue will be announced to registered participants.",
  venue_announce_by: venueAnnounceBy,
  audit_context: label,
};

if (!execute) {
  console.log(JSON.stringify({
    dry_run: true,
    would_create_occurrence: occurrenceInput,
    would_create_promo: { discount_type: "FIXED", discount_value: 1 },
    would_write_key_to: keyPath,
    would_write_manifest_to: manifestPath,
    note: `This is a dry run: no database write, no file write occurred. Set COMMERCE_CERTIFICATION_FIXTURE_EXECUTE=${EXECUTE_CONFIRM} to actually create this fixture. Never pipe this script through head/tail/grep to "preview" it - the mutation still runs in full when COMMERCE_CERTIFICATION_FIXTURE_EXECUTE is set; this dry-run output IS the intended preview.`,
  }, null, 2));
  process.exit(0);
}

if (existsSync(keyPath) && !replaceKey) {
  throw new Error(`Refusing to overwrite existing key file at ${keyPath}. Set COMMERCE_CERTIFICATION_FIXTURE_REPLACE_KEY=${REPLACE_KEY_CONFIRM} only after confirming that key is unused.`);
}

const runId = randomUUID();
const db = openDatabase(databasePath);
const domain = new CommerceDomain(db, new MockProvider());

try {
  const occurrenceKey = randomBytes(16).toString("hex");
  const occurrence = domain.createOccurrence(occurrenceInput, occurrenceKey, "release-control-operator");

  const promoCode = `CERT101-${randomBytes(4).toString("hex").toUpperCase()}`;
  const promoKey = randomBytes(16).toString("hex");
  const promo = domain.createPromoCommand(
    { code: promoCode, status: "ACTIVE", discount_type: "FIXED", discount_value: 1 },
    promoKey,
    "release-control-operator",
    label,
  );

  const checkoutIdempotencyKey = randomBytes(32).toString("hex");
  const checkoutIdempotencyKeyHash = createHash("sha256").update(checkoutIdempotencyKey).digest("hex");

  mkdirSync(dirname(resolve(keyPath)), { recursive: true });
  writeFileSync(keyPath, checkoutIdempotencyKey, { mode: 0o600 });

  const manifest = {
    run_id: runId,
    label,
    occurrence_id: occurrence.id,
    promo_id: promo.id,
    promo_code: promo.code,
    idempotency_key_sha256: checkoutIdempotencyKeyHash,
    key_path: resolve(keyPath),
    created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(resolve(manifestPath)), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

  console.log(JSON.stringify({
    dry_run: false,
    run_id: runId,
    occurrence_id: occurrence.id,
    occurrence_visibility: occurrence.visibility,
    occurrence_sales_status: occurrence.sales_status,
    occurrence_fulfillment_status: occurrence.fulfillment_status,
    occurrence_price_kopecks: occurrence.price_kopecks,
    promo_id: promo.id,
    promo_code: promo.code,
    promo_status: promo.status,
    promo_discount_type: promo.discount_type,
    promo_discount_value: promo.discount_value,
    idempotency_key_sha256: checkoutIdempotencyKeyHash,
    manifest_path: resolve(manifestPath),
  }, null, 2));
} finally {
  db.close();
}
