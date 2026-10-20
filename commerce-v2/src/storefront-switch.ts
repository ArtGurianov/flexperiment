import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { CheckoutConflictError } from "./checkout-conflict";
import type { CommerceRuntimeConfig } from "./payment-mode";
import type { Storefront } from "./origins";

/**
 * The storefront switch (ART-319, design 2026-10-18 §1): the first-sale gate and the emergency stop
 * for new paid money, one state per storefront. Its only authority is a host file the owner writes
 * over SSH (scripts/v2/storefront-switch.py) and mounts read-only into Commerce, beside the owner's
 * append-only journal (also read-only). Commerce has no writer: it reads both on every admission and
 * records what it saw. Missing, unreadable, invalid, mounted writable, not what the journal last
 * recorded, of another scope, older than a generation already seen, or a reused generation: CLOSED. Never selected from env, the merchant database, a backup or the image.
 *
 * A stop refuses new quotes, repeat previews, confirmations and payment initiation (including the
 * recovery of an unanswered create). It never stops reconciliation, fulfilment of accepted payments
 * or refunds. Arbitrary code running inside Commerce can still bypass this in-process check; the
 * control outside Commerce for that case is Refref's operator payment stop (ART-303).
 */
export const STOREFRONT_SWITCH_DIRECTORY = "/etc/flexperiment-sales";
export const STOREFRONT_SWITCH_FILE = "switch.json";
export const STOREFRONT_SWITCH_JOURNAL_DIRECTORY = "/etc/flexperiment-sales-journal";
export const STOREFRONT_SWITCH_JOURNAL_FILE = "journal.jsonl";
const MAX_DOCUMENT_BYTES = 4096;

/** Raw document bytes. Production: the read-only host file. Throws when the file cannot be trusted. */
export type StorefrontSwitchSource = (db: Database.Database) => string;
export type StorefrontSwitchConfig = Pick<CommerceRuntimeConfig, "deployEnvironment" | "storefrontSwitch">;

const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const storefrontState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("OPEN"), openSince: generation }).strict(),
  z.object({ state: z.literal("CLOSED") }).strict(),
]);
const documentSchema = z.object({
  schema: z.literal("flexperiment.storefront-switch/1"),
  scope: z.enum(["local", "canary", "production"]),
  generation,
  changedAt: z.iso.datetime({ offset: true }),
  changedBy: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  reason: z.string().trim().min(3).max(500),
  evidenceIssue: z.string().regex(/^ART-[0-9]{1,6}$/),
  storefronts: z.object({ COURSES: storefrontState, LAB: storefrontState }).strict(),
}).strict().refine((doc) => Object.values(doc.storefronts).every((s) => s.state === "CLOSED" || s.openSince <= doc.generation));
export type StorefrontSwitchDocument = z.infer<typeof documentSchema>;

export type StorefrontSwitchUnavailable = "SOURCE_NOT_CONFIGURED" | "UNREADABLE" | "JOURNAL_MISMATCH" | "JOURNAL_INVALID"
  | "INVALID" | "SCOPE_MISMATCH" | "GENERATION_REGRESSED" | "GENERATION_REUSED" | "OBSERVATION_FAILED";
export type StorefrontSwitchReading =
  | { readonly available: true; readonly document: StorefrontSwitchDocument; readonly sha256: string }
  | { readonly available: false; readonly reason: StorefrontSwitchUnavailable };

/** Where admission ran when a stop refused it; the operator's diagnostic, never shown to the buyer. */
export type SalesStopStage = "NEW_QUOTE" | "ISSUED_QUOTE" | "CONFIRM" | "PAYMENT_INITIATION" | "PAYMENT_RECOVERY" | "CONTROL_ROOM";
export type SalesStopReason = "CLOSED" | "REOPENED_SINCE_QUOTE" | StorefrontSwitchUnavailable;

/** The buyer sees SALES_STOPPED only; the stage and the reason go to the operator log. */
export class SalesStoppedError extends CheckoutConflictError {
  constructor(readonly storefront: Storefront, readonly stage: SalesStopStage, readonly reason: SalesStopReason, readonly generation?: number) {
    super("SALES_STOPPED");
  }
}

const expectedScope = (environment: CommerceRuntimeConfig["deployEnvironment"]) =>
  environment === "production" ? "production" : environment === "staging" ? "canary" : "local";

const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** A host source refusal the operator can act on; any other source failure reads as UNREADABLE. */
export class StorefrontSwitchSourceError extends Error {
  constructor(readonly reason: "JOURNAL_MISMATCH" | "JOURNAL_INVALID") { super(`STOREFRONT_SWITCH_${reason}`); }
}

const JOURNAL_TAIL_BYTES = 64 * 1024;

/** The last complete (newline-terminated) record; a torn append after it is not yet a record. */
function lastJournalRecord(file: string) {
  const descriptor = openSync(file, "r");
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, JOURNAL_TAIL_BYTES);
    const tail = Buffer.alloc(length);
    readSync(descriptor, tail, 0, length, size - length);
    const complete = tail.toString("utf8");
    const end = complete.lastIndexOf("\n");
    const line = end < 0 ? "" : complete.slice(complete.lastIndexOf("\n", end - 1) + 1, end);
    const record = JSON.parse(line) as { generation?: unknown; sha256?: unknown };
    if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1
      || typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error();
    return record as { generation: number; sha256: string };
  } catch {
    throw new StorefrontSwitchSourceError("JOURNAL_INVALID");
  } finally { closeSync(descriptor); }
}

/**
 * The host files, admitted the way the erasure installation evidence is: root-owned 0555 directories
 * that are each their own read-only mount, holding one root-owned 0444 regular file each. The
 * directories, not the files, are mounted, so the owner's atomic rename and journal append on the
 * host are what the runtime reads next.
 *
 * The switch counts only while the journal's last complete record names its exact digest and
 * generation (review P1-1): the journal is the owner's monotonic record, so a switch file restored to an older copy
 * after a stop, or a journal restored without its switch, is CLOSED even when this runtime never
 * saw the newer generation.
 */
export function hostStorefrontSwitchSource(options?: {
  // Trusted filesystem adapter seam for isolated tests only; the server uses the fixed directories,
  // UID 0 and the kernel's mount table, never env options.
  directory: string; journalDirectory: string; ownerUid: number; mountInfo: () => string;
}): StorefrontSwitchSource {
  const directory = options?.directory ?? STOREFRONT_SWITCH_DIRECTORY;
  const journalDirectory = options?.journalDirectory ?? STOREFRONT_SWITCH_JOURNAL_DIRECTORY;
  const ownerUid = options?.ownerUid ?? 0;
  const mountInfo = options?.mountInfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8"));
  const admittedFile = (folderPath: string, name: string, maxBytes: number) => {
    const folder = lstatSync(folderPath);
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== ownerUid || (folder.mode & 0o777) !== 0o555) {
      throw new Error("STOREFRONT_SWITCH_DIRECTORY_INVALID");
    }
    const mounts = mountInfo().split("\n").map((line) => line.split(" - ")[0].split(" "))
      .filter((fields) => fields.length >= 6 && unescapeMount(fields[4]) === folderPath);
    if (mounts.length !== 1 || !mounts[0][5].split(",").includes("ro")) throw new Error("STOREFRONT_SWITCH_MOUNT_INVALID");
    const file = join(folderPath, name);
    const record = lstatSync(file);
    if (!record.isFile() || record.isSymbolicLink() || record.nlink !== 1 || record.uid !== ownerUid
      || (record.mode & 0o777) !== 0o444 || record.size < 1 || record.size > maxBytes) throw new Error("STOREFRONT_SWITCH_FILE_INVALID");
    return file;
  };
  return () => {
    const raw = readFileSync(admittedFile(directory, STOREFRONT_SWITCH_FILE, MAX_DOCUMENT_BYTES));
    const head = lastJournalRecord(admittedFile(journalDirectory, STOREFRONT_SWITCH_JOURNAL_FILE, Number.MAX_SAFE_INTEGER));
    // Digest and generation both: a record naming these bytes under another generation is not theirs.
    let generation: unknown;
    try { generation = (JSON.parse(raw.toString("utf8")) as { generation?: unknown }).generation; } catch { /* INVALID below */ }
    if (head.sha256 !== createHash("sha256").update(raw).digest("hex")
      || (generation !== undefined && head.generation !== generation)) throw new StorefrontSwitchSourceError("JOURNAL_MISMATCH");
    return raw.toString("utf8");
  };
}

/**
 * Reads the switch now, never from a cache: a stop takes effect at the next admission. With `observe`
 * the generation is recorded, so an older file (a restored backup) or a reused generation stays
 * refused after a restart or a database reset. Recording grants nothing: the file alone opens.
 */
export function readStorefrontSwitch(
  db: Database.Database, config: StorefrontSwitchConfig, options: { observe?: boolean; now?: string } = {},
): StorefrontSwitchReading {
  if (!config.storefrontSwitch) return { available: false, reason: "SOURCE_NOT_CONFIGURED" };
  let raw: string;
  try { raw = config.storefrontSwitch(db); }
  catch (error) { return { available: false, reason: error instanceof StorefrontSwitchSourceError ? error.reason : "UNREADABLE" }; }
  if (Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) return { available: false, reason: "INVALID" };
  let document: StorefrontSwitchDocument;
  try { document = documentSchema.parse(JSON.parse(raw)); } catch { return { available: false, reason: "INVALID" }; }
  if (document.scope !== expectedScope(config.deployEnvironment)) return { available: false, reason: "SCOPE_MISMATCH" };
  const sha256 = createHash("sha256").update(raw).digest("hex");
  try {
    if (options.observe !== false) {
      const { COURSES: courses, LAB: lab } = document.storefronts;
      db.prepare(`INSERT OR IGNORE INTO storefront_switch_observations(generation,document_sha256,scope,courses_state,courses_open_since,
        lab_state,lab_open_since,changed_by,reason,evidence_issue,changed_at,first_observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(document.generation, sha256, document.scope, courses.state, courses.state === "OPEN" ? courses.openSince : null,
          lab.state, lab.state === "OPEN" ? lab.openSince : null, document.changedBy, document.reason, document.evidenceIssue,
          document.changedAt, options.now ?? new Date().toISOString());
    }
    const seen = db.prepare("SELECT document_sha256 FROM storefront_switch_observations WHERE generation=?")
      .get(document.generation) as { document_sha256: string } | undefined;
    if (seen && seen.document_sha256 !== sha256) return { available: false, reason: "GENERATION_REUSED" };
    const latest = db.prepare("SELECT MAX(generation) AS generation FROM storefront_switch_observations").get() as { generation: number | null };
    if (latest.generation !== null && latest.generation > document.generation) return { available: false, reason: "GENERATION_REGRESSED" };
  } catch { return { available: false, reason: "OBSERVATION_FAILED" }; }
  return { available: true, document, sha256 };
}

function refuse(storefront: Storefront, stage: SalesStopStage, reason: SalesStopReason, generation?: number): never {
  // Redacted operational signal: no customer, order or document content.
  try { console.error(JSON.stringify({ event: "SALES_STOP_REFUSAL", storefront, stage, reason, ...(generation ? { generation } : {}) })); }
  catch { /* Diagnostic transport must not replace the refusal. */ }
  throw new SalesStoppedError(storefront, stage, reason, generation);
}

/**
 * Admission of new paid money for one storefront. `issuedOpenSince` is the opening a quote was issued
 * under: the quote stays payable only while that same opening lasts, so a stop followed by a reopen
 * ends it (design §2 "storefront close"). An unreadable switch does not end the quote; it refuses until
 * the same opening reads back.
 */
export function assertStorefrontOpen(
  db: Database.Database, config: StorefrontSwitchConfig, storefront: Storefront, stage: SalesStopStage,
  options: { issuedOpenSince?: number | null; now?: string } = {},
) {
  const reading = readStorefrontSwitch(db, config, { now: options.now });
  if (!reading.available) return refuse(storefront, stage, reading.reason);
  const state = reading.document.storefronts[storefront];
  if (state.state !== "OPEN") return refuse(storefront, stage, "CLOSED", reading.document.generation);
  if (options.issuedOpenSince !== undefined && options.issuedOpenSince !== state.openSince) {
    return refuse(storefront, stage, "REOPENED_SINCE_QUOTE", reading.document.generation);
  }
  return { generation: reading.document.generation, openSince: state.openSince };
}

/** What `/readyz` and the owner's read-back report. Informational: readiness never depends on it. */
export function storefrontSwitchStatus(db: Database.Database, config: StorefrontSwitchConfig) {
  const reading = readStorefrontSwitch(db, config, { observe: false });
  if (!reading.available) return { state: "UNAVAILABLE" as const, reason: reading.reason, COURSES: "CLOSED" as const, LAB: "CLOSED" as const };
  const { document } = reading;
  return {
    state: "READ" as const, generation: document.generation, documentSha256: reading.sha256,
    changedAt: document.changedAt, changedBy: document.changedBy, evidenceIssue: document.evidenceIssue,
    COURSES: document.storefronts.COURSES.state, LAB: document.storefronts.LAB.state,
  };
}
