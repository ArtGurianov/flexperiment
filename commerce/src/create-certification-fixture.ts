import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
if (existsSync(manifestPath) && !replaceKey) {
  throw new Error(`Refusing to overwrite existing manifest file at ${manifestPath}. Set COMMERCE_CERTIFICATION_FIXTURE_REPLACE_KEY=${REPLACE_KEY_CONFIRM} only after confirming that fixture is unused.`);
}

const runId = randomUUID();
const db = openDatabase(databasePath);
const domain = new CommerceDomain(db, new MockProvider());
const resolvedKeyPath = resolve(keyPath);
const resolvedManifestPath = resolve(manifestPath);
const stagedKeyPath = `${resolvedKeyPath}.tmp`;
const stagedManifestPath = `${resolvedManifestPath}.tmp`;
let committed = false;
const createdStagedPaths = new Set<string>();

function fsyncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeStaged(path: string, content: string) {
  let descriptor: number;
  try { descriptor = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`CERTIFICATION_FIXTURE_STAGING_ALREADY_EXISTS: ${path}. Reconcile the existing staged artifacts before retrying.`);
    throw error;
  }
  createdStagedPaths.add(path);
  try { writeSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function removeOwnedStagedArtifacts() {
  for (const path of createdStagedPaths) {
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function finalizationPacket(error: unknown, occurrenceId: string, promoId: string, promoCode: string, keyHash: string) {
  return JSON.stringify({
    error: "CERTIFICATION_FIXTURE_ARTIFACT_FINALIZATION_FAILED",
    message: error instanceof Error ? error.message : "Artifact finalization failed.",
    run_id: runId,
    occurrence_id: occurrenceId,
    promo_id: promoId,
    promo_code: promoCode,
    idempotency_key_sha256: keyHash,
    artifacts: [
      { current_path: stagedKeyPath, target_path: resolvedKeyPath, finalized: existsSync(resolvedKeyPath) },
      { current_path: stagedManifestPath, target_path: resolvedManifestPath, finalized: existsSync(resolvedManifestPath) },
    ],
  });
}

try {
  const occurrenceKey = randomBytes(16).toString("hex");
  const promoCode = `CERT101-${randomBytes(4).toString("hex").toUpperCase()}`;
  const promoKey = randomBytes(16).toString("hex");
  const checkoutIdempotencyKey = randomBytes(32).toString("hex");
  const checkoutIdempotencyKeyHash = createHash("sha256").update(checkoutIdempotencyKey).digest("hex");
  const occurrenceId = randomUUID();
  const promoId = randomUUID();
  const manifest = {
    run_id: runId,
    label,
    occurrence_id: occurrenceId,
    promo_id: promoId,
    promo_code: promoCode,
    idempotency_key_sha256: checkoutIdempotencyKeyHash,
    key_path: resolvedKeyPath,
    created_at: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(resolvedKeyPath), { recursive: true });
    mkdirSync(dirname(resolvedManifestPath), { recursive: true });
    writeStaged(stagedKeyPath, checkoutIdempotencyKey);
    writeStaged(stagedManifestPath, JSON.stringify(manifest, null, 2) + "\n");
    fsyncDirectory(dirname(resolvedKeyPath));
    if (dirname(resolvedManifestPath) !== dirname(resolvedKeyPath)) fsyncDirectory(dirname(resolvedManifestPath));
  } catch (error) {
    removeOwnedStagedArtifacts();
    throw error;
  }

  let fixture: ReturnType<CommerceDomain["createCertificationFixture"]>;
  try {
    fixture = domain.createCertificationFixture({
      occurrence: occurrenceInput,
      occurrence_id: occurrenceId,
      occurrence_key: occurrenceKey,
      promo: { code: promoCode, status: "ACTIVE", discount_type: "FIXED", discount_value: 1 },
      promo_id: promoId,
      promo_key: promoKey,
      admin_id: "release-control-operator",
      audit_context: label,
    });
    committed = true;
  } catch (error) {
    removeOwnedStagedArtifacts();
    throw error;
  }

  let finalized = false;
  try {
    if (process.env.NODE_ENV === "test" && process.env.COMMERCE_CERTIFICATION_FIXTURE_TEST_FAIL_AFTER_COMMIT === "1") throw new Error("Injected finalization failure.");
    renameSync(stagedKeyPath, resolvedKeyPath);
    renameSync(stagedManifestPath, resolvedManifestPath);
    fsyncDirectory(dirname(resolvedKeyPath));
    if (dirname(resolvedManifestPath) !== dirname(resolvedKeyPath)) fsyncDirectory(dirname(resolvedManifestPath));
    finalized = true;
  } catch (error) {
    console.error(finalizationPacket(error, occurrenceId, promoId, promoCode, checkoutIdempotencyKeyHash));
    process.exitCode = 2;
  }

  if (finalized) console.log(JSON.stringify({
    dry_run: false,
    run_id: runId,
    occurrence_id: fixture.occurrence.id,
    occurrence_visibility: fixture.occurrence.visibility,
    occurrence_sales_status: fixture.occurrence.sales_status,
    occurrence_fulfillment_status: fixture.occurrence.fulfillment_status,
    occurrence_price_kopecks: fixture.occurrence.price_kopecks,
    promo_id: fixture.promo.id,
    promo_code: fixture.promo.code,
    promo_status: fixture.promo.status,
    promo_discount_type: fixture.promo.discount_type,
    promo_discount_value: fixture.promo.discount_value,
    idempotency_key_sha256: checkoutIdempotencyKeyHash,
    manifest_path: resolvedManifestPath,
  }, null, 2));
} finally {
  if (!committed) {
    try { removeOwnedStagedArtifacts(); } catch { /* preserve the original failure */ }
  }
  db.close();
}
