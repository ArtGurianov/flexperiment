import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { canonicalV2 } from "./crypto";
import {
  EMPTY_SNAPSHOT,
  parseSnapshot,
  type SeoSnapshot,
} from "../../lib/seo/occurrence-snapshot";
import {
  parsePublicOccurrence,
  parsePublicTour,
  SourceContractError,
  type PublicOccurrence,
  type PublicTourSource,
} from "../../lib/seo/public-occurrence";

/** Where the committed artifact lives, relative to the repository root. */
export const SNAPSHOT_PATH = "data/seo/occurrences.v1.json";

/**
 * Serialization is `canonicalV2` plus a trailing newline.
 *
 * canonicalV2 (commerce/src/crypto.ts — imported, never modified; it is in
 * compatibilitySemanticsPaths and editing it has no release lane) sorts object
 * keys recursively, so the bytes depend only on the snapshot's content and not
 * on the order the generator happened to build it in. The trailing newline
 * matches write-static-release-descriptor.ts, so the file is a well-formed text
 * file and git does not report it as lacking one.
 *
 * There is deliberately no `generated_at` anywhere in the artifact. A timestamp
 * would change the bytes on every run, which would destroy the one property
 * worth having here — regenerate from the same source, get the same file — in
 * exchange for provenance that git already records more reliably.
 */
export const serializeSnapshot = (snapshot: SeoSnapshot): string =>
  `${canonicalV2(snapshot)}\n`;

export const readSnapshotFile = (path: string): SeoSnapshot =>
  parseSnapshot(JSON.parse(readFileSync(resolve(path), "utf8")));

/** Reads the committed snapshot, treating "not there yet" as empty. */
export const readSnapshotOrEmpty = (path: string): SeoSnapshot => {
  try {
    return readSnapshotFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return EMPTY_SNAPSHOT;
    throw error;
  }
};

export const writeSnapshotFile = (path: string, snapshot: SeoSnapshot): void => {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeSnapshot(snapshot));
};

/**
 * A recorded source reading, as `--input` accepts it.
 *
 * This is not an invented format: it is exactly the two endpoint bodies the
 * production path fetches, written down. `occurrences` maps an id to what
 * `GET /v1/public/occurrences/{id}` returned, with `null` for a 404 — which is
 * how a fixture expresses "Commerce no longer exposes this at all" without
 * needing a server to refuse a request.
 */
export const parseRecordedSource = (value: unknown): PublicTourSource => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceContractError("input");
  }
  const record = value as Record<string, unknown>;
  const tour = parsePublicTour(record.tour);
  const departed = new Map<string, PublicOccurrence | null>();
  const raw = record.occurrences;
  if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SourceContractError("input.occurrences");
    }
    for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
      departed.set(id, entry === null ? null : parsePublicOccurrence(entry, `input.occurrences.${id}`));
    }
  }
  return { tour, departed };
};

export const readRecordedSource = (path: string): PublicTourSource =>
  parseRecordedSource(JSON.parse(readFileSync(resolve(path), "utf8")));

/**
 * The production reading: one call for the catalogue, then one call per
 * previously published id that is no longer in it.
 *
 * HTTP is the only workable production source. The production SQLite file sits
 * on a Coolify volume reachable only from the api resource, so there is no
 * direct-read path from a controller checkout.
 *
 * `/v1/public/occurrences/{id}` is what disambiguates a departure: unlike
 * `tour()`, it applies no SCHEDULED-and-future filter, so it can still answer
 * for a cancelled, completed or already-started occurrence.
 */
export const fetchSource = async (
  origin: string,
  previouslyPublishedIds: readonly string[],
): Promise<PublicTourSource> => {
  const base = origin.replace(/\/+$/, "");
  const tourResponse = await fetch(`${base}/v1/public/tour`, { cache: "no-store" });
  if (!tourResponse.ok) throw new Error(`SEO_SNAPSHOT_SOURCE_UNREADABLE:tour:${tourResponse.status}`);
  const tour = parsePublicTour(await tourResponse.json());

  const live = new Set(tour.map((entry) => entry.id));
  const departed = new Map<string, PublicOccurrence | null>();
  for (const id of previouslyPublishedIds) {
    if (live.has(id)) continue;
    const response = await fetch(`${base}/v1/public/occurrences/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 404) {
      departed.set(id, null);
      continue;
    }
    if (!response.ok) throw new Error(`SEO_SNAPSHOT_SOURCE_UNREADABLE:occurrence:${id}:${response.status}`);
    departed.set(id, parsePublicOccurrence(await response.json(), `occurrences.${id}`));
  }
  return { tour, departed };
};
