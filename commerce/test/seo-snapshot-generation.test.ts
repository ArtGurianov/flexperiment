import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_SNAPSHOT, parseSnapshot } from "../../lib/seo/occurrence-snapshot";
import { eventStatusFor, findSnapshotDefects } from "../../lib/seo/occurrence-publication";
import { buildSnapshot, parsePublicTour, SourceContractError } from "../../lib/seo/public-occurrence";
import { publicOccurrence } from "../../lib/seo/public-occurrence-fixture";
import {
  parseRecordedSource,
  readSnapshotOrEmpty,
  serializeSnapshot,
  SNAPSHOT_PATH,
  writeSnapshotFile,
} from "../src/seo-snapshot-io";

const directories: string[] = [];

const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "seo-snapshot-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

const source = (tour: unknown[], occurrences: Record<string, unknown> = {}) =>
  parseRecordedSource({ tour: { cities: tour }, occurrences });

const NOW = Date.parse("2029-01-01T00:00:00Z");

describe("snapshot generation", () => {
  it("projects only the durable subset and drops live state", () => {
    const snapshot = buildSnapshot({ source: source([publicOccurrence()]), previous: EMPTY_SNAPSHOT, nowMs: NOW });
    const [entry] = snapshot.occurrences;

    expect(Object.keys(entry).sort()).toEqual([
      "city", "city_title", "ends_at", "event_slug", "fulfillment_status",
      "id", "price_kopecks", "starts_at", "timezone", "title", "venue",
    ]);
    // availability, purchase_status and sales_status are clock- and
    // gate-dependent; freezing them into static HTML would publish a claim
    // about seats that is stale the moment it is written.
    expect(entry).not.toHaveProperty("availability");
    expect(entry).not.toHaveProperty("purchase_status");
    expect(entry).not.toHaveProperty("sales_status");
    // The venue's disclosure wording and announce_by deadline are Commerce's
    // copy for the checkout dialog, not facts an event page restates.
    expect(Object.keys(entry.venue).sort()).toEqual(["address", "name", "status"]);
  });

  it("regenerates byte-identically from the same source", () => {
    const first = buildSnapshot({ source: source([publicOccurrence()]), previous: EMPTY_SNAPSHOT, nowMs: NOW });
    const second = buildSnapshot({ source: source([publicOccurrence()]), previous: first, nowMs: NOW + 86_400_000 });

    expect(serializeSnapshot(second)).toBe(serializeSnapshot(first));
    // A `generated_at` field is exactly what this test exists to forbid: the
    // two builds are a day apart and must still produce the same bytes.
    expect(serializeSnapshot(first)).not.toContain("generated_at");
  });

  it("serializes with sorted keys and a trailing newline", () => {
    const serialized = serializeSnapshot(EMPTY_SNAPSHOT);
    expect(serialized).toBe('{"occurrences":[],"schema_version":1,"tombstones":[]}\n');
  });

  it("orders records by starts_at, then city, then id", () => {
    const later = publicOccurrence({
      id: "22222222-2222-4333-8444-555555555555",
      starts_at: "2030-09-14T11:00:00.000Z",
      ends_at: "2030-09-14T15:00:00.000Z",
    });
    const moscow = publicOccurrence({
      id: "33333333-2222-4333-8444-555555555555",
      city: "moscow", city_title: "Москва", timezone: "Europe/Moscow",
    });
    const snapshot = buildSnapshot({ source: source([later, publicOccurrence(), moscow]), previous: EMPTY_SNAPSHOT, nowMs: NOW });

    expect(snapshot.occurrences.map((entry) => entry.id)).toEqual([
      "33333333-2222-4333-8444-555555555555", // same start as the base, city "moscow" < "novosibirsk"
      "11111111-2222-4333-8444-555555555555",
      "22222222-2222-4333-8444-555555555555",
    ]);
    expect(findSnapshotDefects(snapshot)).toEqual([]);
  });

  it("freezes the slug at first publication and updates only the page content when a city moves", () => {
    const published = buildSnapshot({ source: source([publicOccurrence()]), previous: EMPTY_SNAPSHOT, nowMs: NOW });
    const moved = buildSnapshot({
      source: source([publicOccurrence({ city: "moscow", city_title: "Москва", timezone: "Europe/Moscow" })]),
      previous: published,
      nowMs: NOW,
    });

    expect(moved.occurrences[0].event_slug).toBe(published.occurrences[0].event_slug);
    expect(moved.occurrences[0].event_slug).toContain("novosibirsk");
    expect(moved.occurrences[0].city).toBe("moscow");
    expect(moved.occurrences[0].timezone).toBe("Europe/Moscow");
  });

  it("tombstones an occurrence that leaves the tour, recording why", () => {
    const published = buildSnapshot({ source: source([publicOccurrence()]), previous: EMPTY_SNAPSHOT, nowMs: NOW });
    const id = publicOccurrence().id;

    const cancelled = buildSnapshot({
      source: source([], { [id]: publicOccurrence({ fulfillment_status: "CANCELLED" }) }),
      previous: published,
      nowMs: NOW,
    });
    expect(cancelled.occurrences).toEqual([]);
    expect(cancelled.tombstones[0]).toMatchObject({ departed: "CANCELLED", fulfillment_status: "CANCELLED" });
    // The URL survives. That is the entire reason tombstones exist.
    expect(cancelled.tombstones[0].event_slug).toBe(published.occurrences[0].event_slug);

    const completed = buildSnapshot({
      source: source([], { [id]: publicOccurrence({ fulfillment_status: "COMPLETED" }) }),
      previous: published, nowMs: NOW,
    });
    expect(completed.tombstones[0].departed).toBe("COMPLETED");

    // Still SCHEDULED but the start time has passed: tour() filters on
    // `starts_at > now`, so this is why it fell out.
    const past = buildSnapshot({
      source: source([], { [id]: publicOccurrence() }),
      previous: published,
      nowMs: Date.parse("2031-01-01T00:00:00Z"),
    });
    expect(past.tombstones[0].departed).toBe("PAST");

    // 404 from /v1/public/occurrences/{id}: Commerce no longer exposes it, so
    // the last known record is carried forward rather than invented.
    const withdrawn = buildSnapshot({
      source: source([], { [id]: null }), previous: published, nowMs: NOW,
    });
    expect(withdrawn.tombstones[0].departed).toBe("WITHDRAWN");
    expect(withdrawn.tombstones[0].title).toBe(published.occurrences[0].title);
  });

  it("re-projects a tombstone from the live record, so a corrected venue still shows", () => {
    const published = buildSnapshot({
      source: source([publicOccurrence({ venue: { status: "TO_BE_ANNOUNCED", name: null, address: null, disclosure_text: "Скоро", announce_by: null } })]),
      previous: EMPTY_SNAPSHOT, nowMs: NOW,
    });
    expect(published.occurrences[0].venue.status).toBe("TO_BE_ANNOUNCED");

    const cancelledAtAKnownVenue = buildSnapshot({
      source: source([], { [publicOccurrence().id]: publicOccurrence({ fulfillment_status: "CANCELLED" }) }),
      previous: published, nowMs: NOW,
    });
    expect(cancelledAtAKnownVenue.tombstones[0].venue).toEqual({
      status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1",
    });
  });

  it("never lets a sales state reach the snapshot, let alone imply a cancellation", () => {
    // The strongest form of "eventStatus comes from fulfillment only": the
    // fields it could wrongly be derived from are not carried at all. A
    // NOT_YET_OPEN, SOLD_OUT or gate-paused occurrence is a SCHEDULED event
    // that is not currently selling, and marking it EventCancelled in search
    // results would be a false public claim about a live event.
    for (const sales of ["CLOSED", "PAUSED"] as const) {
      for (const purchase of ["NOT_YET_OPEN", "SOLD_OUT", "TEMPORARILY_PAUSED", "UNAVAILABLE"] as const) {
        const snapshot = buildSnapshot({
          source: source([publicOccurrence({ sales_status: sales, purchase_status: purchase, availability: 0 })]),
          previous: EMPTY_SNAPSHOT,
          nowMs: NOW,
        });
        const [entry] = snapshot.occurrences;
        expect(entry.fulfillment_status).toBe("SCHEDULED");
        expect(eventStatusFor(entry)).toBe("https://schema.org/EventScheduled");
        expect(serializeSnapshot(snapshot)).not.toContain(purchase);
        expect(serializeSnapshot(snapshot)).not.toContain("availability");
      }
    }
  });

  it("produces zero records from an empty tour and stays structurally valid", () => {
    const snapshot = buildSnapshot({ source: source([]), previous: EMPTY_SNAPSHOT, nowMs: NOW });
    expect(snapshot).toEqual(EMPTY_SNAPSHOT);
    expect(findSnapshotDefects(snapshot)).toEqual([]);
  });
});

describe("the source contract", () => {
  it("refuses a body that is not the expected shape rather than guessing", () => {
    expect(() => parsePublicTour({})).toThrow(SourceContractError);
    expect(() => parsePublicTour({ cities: [{}] })).toThrow(SourceContractError);
    expect(() => parsePublicTour({ cities: [{ ...publicOccurrence(), price_kopecks: "380000" }] }))
      .toThrow("price_kopecks");
    expect(() => parsePublicTour({ cities: [{ ...publicOccurrence(), fulfillment_status: "POSTPONED" }] }))
      .toThrow("fulfillment_status");
  });

  it("keeps a 404 distinguishable from an absent re-fetch", () => {
    const parsed = parseRecordedSource({ tour: { cities: [] }, occurrences: { "a": null } });
    expect(parsed.departed.get("a")).toBeNull();
    expect(parsed.departed.has("b")).toBe(false);
  });
});

describe("the committed artifact", () => {
  it("is valid, canonical and reflects that today's production inventory is rejected", () => {
    const raw = readFileSync(SNAPSHOT_PATH, "utf8");
    const snapshot = parseSnapshot(JSON.parse(raw));

    expect(raw).toBe(serializeSnapshot(snapshot));
    expect(findSnapshotDefects(snapshot)).toEqual([]);
    // Production's only occurrence is a saint-petersburg record carrying
    // Asia/Novosibirsk, which judgeOccurrence rejects outright — so the
    // architecture is in place and publishes nothing. This assertion changes
    // only when that record is corrected and the snapshot regenerated.
    expect(snapshot.occurrences).toEqual([]);
    expect(snapshot.tombstones).toEqual([]);
  });

  it("round-trips through write and read unchanged", () => {
    const path = join(scratch(), "occurrences.v1.json");
    const snapshot = buildSnapshot({ source: source([publicOccurrence()]), previous: EMPTY_SNAPSHOT, nowMs: NOW });
    writeSnapshotFile(path, snapshot);
    expect(readSnapshotOrEmpty(path)).toEqual(snapshot);
  });

  it("treats a missing snapshot as empty but a corrupt one as fatal", () => {
    const directory = scratch();
    expect(readSnapshotOrEmpty(join(directory, "absent.json"))).toEqual(EMPTY_SNAPSHOT);

    const corrupt = join(directory, "corrupt.json");
    writeFileSync(corrupt, '{"schema_version":1,"occurrences":[{"id":"x"}],"tombstones":[]}');
    expect(() => readSnapshotOrEmpty(corrupt)).toThrow("SEO_SNAPSHOT_MALFORMED");
  });
});
