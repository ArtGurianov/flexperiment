import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { checkout, prepareCheckout, confirmCheckout, MockPaymentRail } from "../src/checkout";
import { configureProduct } from "../src/catalog-control";
import { controlRoomLabOccurrences } from "../src/control-room";
import { applyV2Migration, migrateV2 } from "../src/db";
import { cancelLabOccurrence, createCity, createLabOccurrence, editLabOccurrence, labSeatInventory, renameCity,
  type LabOccurrenceCreateCommand } from "../src/lab-occurrences";
import { publicLabCatalogue } from "../src/lab-catalogue";
import { stageALegalManifestJson } from "./fixtures/legal";
import { activatePublicSales, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NOW = "2026-09-30T10:00:00Z";
const REF = "lab:november";
let db: Database.Database;
let rail: MockPaymentRail;

const occurrence = (overrides: Partial<LabOccurrenceCreateCommand> = {}): LabOccurrenceCreateCommand => ({
  occurrenceRef: REF, citySlug: "nsk", title: "LAB в ноябре", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T17:00:00Z",
  timezone: "Asia/Novosibirsk", capacity: 2, venue: { status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1", public: false },
  actor: "operator", reason: "Новая встреча", ...overrides,
});
const row = () => db.prepare("SELECT * FROM lab_occurrences WHERE occurrence_ref=?").get(REF) as Record<string, unknown>;
const version = () => row().version as number;
const edit = (patch: Parameters<typeof editLabOccurrence>[1]["patch"], now = NOW) =>
  editLabOccurrence(db, { occurrenceRef: REF, expectedVersion: version(), patch, actor: "operator", reason: "Правка" }, now);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new MockPaymentRail();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('lab-legal','LAB','lab-stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  createCity(db, { slug: "nsk", title: "Новосибирск", actor: "operator" }, NOW);
  createLabOccurrence(db, occurrence(), NOW);
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('lab-product',?,'LAB','PAID',?)`).run(REF, REF);
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode,payment_purpose)
    VALUES ('lab-offer',?,'lab-product',250000,'PUBLIC','Участие в мастер-классе LAB')`).run(REF);
  qualifyTestFiscalPolicies(db);
  activatePublicSales(db, "LAB");
});

let customers = 0;
const buy = (scenario?: string, now = NOW) => {
  const id = `customer-${++customers}`;
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id}@example.com`);
  return checkout(db, rail, testCheckoutConfig, { customerId: id, customerEmail: `${id}@example.com`, offerRef: REF,
    idempotencyKey: `lab-${id}`, scenario }, now);
};

describe("LAB occurrence schema (migration 0029)", () => {
  it("drops the second sales status and keeps a legacy row unlisted until it declares a venue", () => {
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    const directory = join(process.cwd(), "commerce-v2", "migrations");
    for (const version of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      if (version.startsWith("0029")) break;
      applyV2Migration(legacy, version, readFileSync(join(directory, version), "utf8"));
    }
    legacy.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','msk','Москва')").run();
    legacy.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,sales_status)
      VALUES ('legacy','lab:legacy','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Europe/Moscow',5,'PUBLIC')`).run();
    migrateV2(legacy);
    const columns = (legacy.prepare("PRAGMA table_info(lab_occurrences)").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns).not.toContain("sales_status");
    expect(legacy.prepare("SELECT lifecycle,visibility,venue_status,version FROM lab_occurrences").get())
      .toEqual({ lifecycle: "SCHEDULED", visibility: "UNLISTED", venue_status: null, version: 1 });
    expect(() => legacy.prepare("UPDATE lab_occurrences SET visibility='LISTED'").run()).toThrow("LAB_OCCURRENCE_CONTRACT_INVALID");
    expect(editLabOccurrence(legacy, { occurrenceRef: "lab:legacy", expectedVersion: 1, actor: "operator", reason: "Площадка",
      patch: { venue: { status: "CONFIRMED", name: "Зал", address: "Тверская, 1", public: true }, visibility: "LISTED" } }, NOW))
      .toMatchObject({ version: 2, changed: true });
    legacy.close();
  });

  it("refuses incomplete venues, oversized reserves and identity changes in SQL, not only in the command", () => {
    const insert = (venue: string) => () => db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,
      venue_status,venue_name,venue_address,venue_disclosure_text,venue_announce_by) VALUES ('x','lab:x',(SELECT id FROM cities),'LAB',
      '2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','UTC',2,${venue})`).run();
    expect(insert("NULL,NULL,NULL,NULL,NULL")).toThrow("LAB_OCCURRENCE_CONTRACT_INVALID");
    expect(insert("'CONFIRMED','Зал',NULL,NULL,NULL")).toThrow("LAB_OCCURRENCE_CONTRACT_INVALID");
    expect(insert("'TO_BE_ANNOUNCED',NULL,NULL,'Скоро','2026-11-02T00:00:00Z'")).toThrow("LAB_OCCURRENCE_CONTRACT_INVALID");
    expect(() => db.prepare("UPDATE lab_occurrences SET admin_reserved_seats=3").run()).toThrow("LAB_OCCURRENCE_CONTRACT_INVALID");
    expect(() => db.prepare("UPDATE lab_occurrences SET occurrence_ref='lab:other'").run()).toThrow();
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('other','tomsk','Томск')").run();
    expect(() => db.prepare("UPDATE lab_occurrences SET city_id='other'").run()).toThrow("LAB_OCCURRENCE_CONTRACT_INVALID");
    expect(() => db.prepare("UPDATE cities SET slug='renamed' WHERE id='other'").run()).toThrow("CITY_IDENTITY_IMMUTABLE");
    expect(() => db.prepare("UPDATE lab_occurrence_revisions SET reason='rewritten'").run()).toThrow("LAB_OCCURRENCE_REVISION_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM lab_occurrence_revisions").run()).toThrow("LAB_OCCURRENCE_REVISION_IMMUTABLE");
  });
});

describe("cities and occurrence creation", () => {
  it("keeps a city slug and audits a rename", () => {
    expect(() => createCity(db, { slug: "nsk", title: "Дубль", actor: "operator" }, NOW)).toThrow("CITY_SLUG_TAKEN");
    expect(() => createCity(db, { slug: "Not A Slug", title: "Город", actor: "operator" }, NOW)).toThrow("CITY_SLUG_INVALID");
    expect(renameCity(db, { slug: "nsk", title: "Новосибирск (центр)", actor: "operator" }, NOW).title).toBe("Новосибирск (центр)");
    expect(db.prepare("SELECT action FROM audit_log WHERE subject_type='CITY' ORDER BY rowid").all())
      .toEqual([{ action: "CITY_CREATED" }, { action: "CITY_RENAMED" }]);
  });

  it("creates an UNLISTED, SCHEDULED occurrence with a CREATED revision", () => {
    expect(row()).toMatchObject({ lifecycle: "SCHEDULED", visibility: "UNLISTED", version: 1, material_revision: 1, capacity: 2,
      admin_reserved_seats: 0, venue_status: "CONFIRMED", venue_public: 0 });
    expect(db.prepare("SELECT change_kind,version,before_json,actor,reason FROM lab_occurrence_revisions").all())
      .toEqual([{ change_kind: "CREATED", version: 1, before_json: null, actor: "operator", reason: "Новая встреча" }]);
  });

  it.each([
    [{ occurrenceRef: REF }, "LAB_OCCURRENCE_REF_TAKEN"],
    [{ occurrenceRef: "lab:past", startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-01T17:00:00Z" }, "LAB_OCCURRENCE_STARTS_IN_PAST"],
    [{ occurrenceRef: "lab:ms", startsAt: "2026-11-01T09:00:00.500Z" }, "LAB_OCCURRENCE_TIME_INVALID"],
    [{ occurrenceRef: "lab:reversed", endsAt: "2026-11-01T08:00:00Z" }, "LAB_OCCURRENCE_TIME_INVALID"],
    [{ occurrenceRef: "lab:tz", timezone: "Mars/Olympus" }, "LAB_OCCURRENCE_TIMEZONE_INVALID"],
    [{ occurrenceRef: "lab:reserve", adminReservedSeats: 3 }, "LAB_RESERVE_EXCEEDS_AVAILABLE_CAPACITY"],
    [{ occurrenceRef: "lab:city", citySlug: "nowhere" }, "CITY_NOT_FOUND"],
    [{ occurrenceRef: "lab:tba", venue: { status: "TO_BE_ANNOUNCED" as const, disclosureText: "Скоро", announceBy: "2026-11-01T09:00:00Z" } },
      "LAB_VENUE_ANNOUNCEMENT_TOO_LATE"],
    [{ occurrenceRef: "lab:empty", venue: { status: "CONFIRMED" as const, name: " ", address: "Адрес", public: true } }, "LAB_VENUE_CONFIRMATION_INCOMPLETE"],
    [{ occurrenceRef: "lab:reason", reason: "" }, "LAB_CHANGE_REASON_REQUIRED"],
  ])("refuses %o with %s", (overrides, code) => {
    expect(() => createLabOccurrence(db, occurrence(overrides), NOW)).toThrow(code);
  });
});

describe("occurrence edits (design §4)", () => {
  it("refuses a stale version and leaves a no-op without a new version", () => {
    expect(() => editLabOccurrence(db, { occurrenceRef: REF, expectedVersion: 7, patch: { title: "X" }, actor: "operator", reason: "r" }, NOW))
      .toThrow("LAB_OCCURRENCE_VERSION_CONFLICT");
    expect(edit({ title: "LAB в ноябре" })).toEqual({ occurrenceRef: REF, version: 1, changed: false });
  });

  it("records every change and bumps the material revision only for customer-facing facts", () => {
    edit({ capacity: 5, adminReservedSeats: 1, visibility: "LISTED" });
    expect(row()).toMatchObject({ version: 2, material_revision: 1, capacity: 5, admin_reserved_seats: 1, visibility: "LISTED" });
    edit({ title: "LAB: движение" });
    expect(row()).toMatchObject({ version: 3, material_revision: 2 });
    const revisions = db.prepare("SELECT version,change_kind,customer_facing,changed_fields_json FROM lab_occurrence_revisions ORDER BY version").all();
    expect(revisions).toEqual([
      { version: 1, change_kind: "CREATED", customer_facing: 1, changed_fields_json: "[]" },
      { version: 2, change_kind: "EDITED", customer_facing: 0, changed_fields_json: JSON.stringify(["capacity", "admin_reserved_seats", "visibility"]) },
      { version: 3, change_kind: "EDITED", customer_facing: 1, changed_fields_json: JSON.stringify(["title"]) },
    ]);
  });

  it("moves an unsold occurrence freely but locks schedule and venue once a seat is committed", async () => {
    edit({ startsAt: "2026-11-02T09:00:00Z", endsAt: "2026-11-02T17:00:00Z" });
    edit({ venue: { status: "TO_BE_ANNOUNCED", disclosureText: "Площадка в центре", announceBy: "2026-10-25T09:00:00Z" } });
    await buy();
    expect(labSeatInventory(db, row() as never)).toMatchObject({ customerCommitted: 1, available: 1 });
    expect(() => edit({ startsAt: "2026-11-03T09:00:00Z", endsAt: "2026-11-03T17:00:00Z" })).toThrow("LAB_OCCURRENCE_SCHEDULE_LOCKED");
    expect(() => edit({ timezone: "Europe/Moscow" })).toThrow("LAB_OCCURRENCE_SCHEDULE_LOCKED");
    expect(() => edit({ venue: { status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1", public: true } }))
      .toThrow("LAB_VENUE_CHANGE_REQUIRES_WORKFLOW");
    expect(edit({ title: "LAB: новая программа", visibility: "LISTED" }).changed).toBe(true);
  });

  it("keeps capacity and the admin reserve above committed seats", async () => {
    await buy();
    await buy();
    expect(labSeatInventory(db, row() as never)).toMatchObject({ customerCommitted: 2, available: 0 });
    expect(() => edit({ capacity: 1 })).toThrow("LAB_CAPACITY_BELOW_COMMITTED_SEATS");
    expect(() => edit({ adminReservedSeats: 1 })).toThrow("LAB_RESERVE_EXCEEDS_AVAILABLE_CAPACITY");
    edit({ capacity: 3, adminReservedSeats: 1 });
    expect(labSeatInventory(db, row() as never)).toMatchObject({ capacity: 3, adminReservedSeats: 1, available: 0 });
  });

  it("frees a seat only on a final order outcome", async () => {
    await buy("expiry");
    expect(labSeatInventory(db, row() as never)).toMatchObject({ customerCommitted: 0, available: 2 });
    await buy("ambiguous_create");
    expect(labSeatInventory(db, row() as never)).toMatchObject({ pending: 1, customerCommitted: 1 });
  });

  it("refuses schedule changes after the start and any edit after the end", () => {
    expect(() => edit({ endsAt: "2026-11-01T18:00:00Z" }, "2026-11-01T10:00:00Z")).toThrow("LAB_OCCURRENCE_STARTED");
    expect(edit({ capacity: 3 }, "2026-11-01T10:00:00Z").changed).toBe(true);
    expect(() => edit({ capacity: 4 }, "2026-11-01T17:00:00Z")).toThrow("LAB_OCCURRENCE_FINISHED");
    expect(() => edit({ startsAt: "2026-09-30T09:00:00Z", endsAt: "2026-09-30T12:00:00Z" })).toThrow("LAB_OCCURRENCE_STARTS_IN_PAST");
  });
});

describe("occurrence cancellation", () => {
  const cancel = (now = NOW) => cancelLabOccurrence(db, { occurrenceRef: REF, expectedVersion: version(), actor: "operator", reason: "Болезнь преподавателя" }, now);

  it("leaves a cancellation with a committed seat to the ART-203 workflow", async () => {
    await buy();
    expect(() => cancel()).toThrow("LAB_OCCURRENCE_HAS_COMMITTED_SEATS");
    expect(row().lifecycle).toBe("SCHEDULED");
  });

  it("cancels an unsold occurrence, closes its offer and keeps it closed", () => {
    cancel();
    expect(row()).toMatchObject({ lifecycle: "CANCELLED", cancellation_reason: "Болезнь преподавателя", version: 2 });
    expect(db.prepare("SELECT sale_mode FROM offers").get()).toEqual({ sale_mode: "CLOSED" });
    expect(() => edit({ title: "Вернули" })).toThrow("LAB_OCCURRENCE_CANCELLED");
    expect(() => cancel()).toThrow("LAB_OCCURRENCE_CANCELLED");
    expect(() => db.prepare("UPDATE lab_occurrences SET lifecycle='SCHEDULED',cancelled_at=NULL,cancellation_reason=NULL").run())
      .toThrow("LAB_OCCURRENCE_CONTRACT_INVALID");
    const product = db.prepare("SELECT version FROM products").get() as { version: number };
    expect(() => configureProduct(db, testCheckoutConfig, { productRef: REF, offerRef: REF, kind: "LAB", accessModel: "PAID",
      occurrenceRef: REF, priceKopecks: 250000, saleMode: "PUBLIC", actor: "operator", expectedVersion: product.version }, NOW))
      .toThrow("LAB_OCCURRENCE_CANCELLED");
    expect(() => cancel("2026-11-01T17:00:00Z")).toThrow();
  });
});

describe("LAB checkout admission (design §11.1)", () => {
  it("refuses a direct PUBLIC offerRef whose occurrence is full, started or cancelled", async () => {
    await buy();
    edit({ adminReservedSeats: 1 });
    await expect(buy()).rejects.toThrow("LAB_OCCURRENCE_SOLD_OUT");
    edit({ adminReservedSeats: 0 });
    await expect(buy(undefined, "2026-11-01T09:00:00Z")).rejects.toThrow("LAB_OCCURRENCE_STARTED");
    await buy();
    await expect(buy()).rejects.toThrow("LAB_OCCURRENCE_SOLD_OUT");
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 2 });
  });

  it("refuses a cancelled occurrence even if its offer row were reopened", async () => {
    cancelLabOccurrence(db, { occurrenceRef: REF, expectedVersion: 1, actor: "operator", reason: "Отмена" }, NOW);
    db.prepare("UPDATE offers SET sale_mode='PUBLIC'").run();
    await expect(buy()).rejects.toThrow("LAB_OCCURRENCE_CANCELLED");
  });

  it("freezes the venue the buyer was promised into the order line", async () => {
    await buy();
    edit({ capacity: 4 });
    const line = JSON.parse((db.prepare("SELECT occurrence_snapshot_json FROM order_lines").get() as { occurrence_snapshot_json: string }).occurrence_snapshot_json);
    expect(line.venue).toEqual({ status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1" });
  });
});

describe("LAB read models", () => {
  it("lists only LISTED, scheduled, future occurrences and discloses a private venue only to buyers", async () => {
    const catalogue = () => publicLabCatalogue(db, "mock", new Date(NOW)).occurrences;
    expect(catalogue()).toEqual([]);
    edit({ visibility: "LISTED" });
    expect(catalogue()).toMatchObject([{ occurrenceRef: REF, venue: { status: "CONFIRMED", name: null, address: null }, soldOut: false }]);
    edit({ venue: { status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1", public: true } });
    expect(catalogue()[0].venue).toEqual({ status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1" });
    await buy();
    await buy();
    expect(catalogue()[0].soldOut).toBe(true);
    expect(publicLabCatalogue(db, "mock", new Date("2026-11-01T09:00:00Z")).occurrences).toEqual([]);
    expect(controlRoomLabOccurrences(db, NOW).occurrences[0]).toMatchObject({ phase: "SCHEDULED", visibility: "LISTED", capacity: 2,
      soldSeats: 2, pendingSeats: 0, availableSeats: 0, offerRef: REF, saleMode: "PUBLIC", version: 3 });
    expect(controlRoomLabOccurrences(db, "2026-11-01T10:00:00Z").occurrences[0].phase).toBe("IN_PROGRESS");
    expect(controlRoomLabOccurrences(db, "2026-11-01T17:00:00Z").occurrences[0].phase).toBe("FINISHED");
  });

  it("hides a cancelled occurrence from the catalogue", () => {
    edit({ visibility: "LISTED" });
    cancelLabOccurrence(db, { occurrenceRef: REF, expectedVersion: version(), actor: "operator", reason: "Отмена" }, NOW);
    expect(publicLabCatalogue(db, "mock", new Date(NOW)).occurrences).toEqual([]);
    expect(controlRoomLabOccurrences(db, NOW).occurrences[0]).toMatchObject({ phase: "CANCELLED", saleMode: "CLOSED" });
  });
});

it.each(["CONFIRMED", "TO_BE_ANNOUNCED"] as const)("returns the frozen %s venue for buyer review before payment", async status => {
  if (status === "TO_BE_ANNOUNCED") edit({ venue: { status, disclosureText: "Площадка в центре", announceBy: "2026-10-20T00:00:00Z" } });
  edit({ visibility: "LISTED" });
  const id = `customer-${++customers}`;
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id}@example.com`);
  const input = { customerId: id, customerEmail: `${id}@example.com`, offerRef: REF, previewIdempotencyKey: `venue-${id}` };
  const preview = await prepareCheckout(db, rail, testCheckoutConfig, input, NOW);
  expect(preview.state).toBe("PRICE_REVIEW_REQUIRED");
  if (preview.state !== "PRICE_REVIEW_REQUIRED") throw new Error("quote expected");
  expect(db.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 0 });
  expect(preview.occurrence?.venue).toEqual(status === "CONFIRMED"
    ? { status, name: "Студия", address: "Красный проспект, 1" }
    : { status, disclosureText: "Площадка в центре", announceBy: "2026-10-20T00:00:00Z" });
  expect(JSON.stringify(publicLabCatalogue(db, "mock", new Date(NOW)))).not.toContain("Красный проспект");
  const replay = await prepareCheckout(db, rail, testCheckoutConfig, input, NOW);
  expect(replay).toEqual(preview);
  await confirmCheckout(db, rail, testCheckoutConfig, { customerId: id, customerEmail: input.customerEmail,
    quoteId: preview.quoteId, idempotencyKey: `confirm-${id}` }, NOW);
  const line = db.prepare("SELECT occurrence_snapshot_json FROM order_lines").get() as { occurrence_snapshot_json: string };
  expect(JSON.parse(line.occurrence_snapshot_json)).toEqual(preview.occurrence);
});
