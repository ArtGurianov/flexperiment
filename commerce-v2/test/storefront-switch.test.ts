import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { checkout, confirmCheckout, MockPaymentRail, prepareCheckout, reconcileCheckout, reconcilePendingCheckouts } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { RefrefPaymentRail } from "../src/refref-payment-rail";
import { retireFiscalPolicy } from "../src/fiscal-policy";
import { runOwnerCommand } from "../src/owner-cli";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import type { RefundEnvelopeKeyring } from "../src/refund-envelope";
import { decideRefund, executeApprovedRefund, requestRefund } from "../src/refunds";
import { assertStorefrontOpen, hostStorefrontSwitchSource, readStorefrontSwitch, SalesStoppedError, STOREFRONT_SWITCH_FILE,
  STOREFRONT_SWITCH_JOURNAL_FILE, type StorefrontSwitchSource } from "../src/storefront-switch";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { qualifyTestFiscalPolicies, setTestStorefronts, setTestStorefrontSwitchRaw, testCheckoutConfig, testStorefrontSwitchDocument } from "./fixtures/sales";

// ART-319: the owner's storefront switch, the first-sale gate and emergency stop for new paid money.

let db: Database.Database;
let rail: MockPaymentRail;
let beforeRead: (() => void) | undefined;
let refusals: Array<{ stage: string; reason: string; storefront: string }>;

/** The fixture switch, with a hook that runs before each read: a stop can land at an exact checkpoint. */
const config = { ...testCheckoutConfig, storefrontSwitch: (d: Database.Database) => { beforeRead?.(); return testCheckoutConfig.storefrontSwitch(d); } };
const stopOnRead = (n: number) => {
  let reads = 0;
  beforeRead = () => { reads += 1; if (reads === n) { beforeRead = undefined; setTestStorefronts(db, { COURSES: "CLOSED" }); } };
};

const T0 = "2026-09-30T10:00:00.000Z";
const at = (minutes: number) => new Date(new Date(T0).getTime() + minutes * 60_000).toISOString();
const customer = { customerId: "customer", customerEmail: "student@example.com" };
const preview = (key: string, extra: Partial<Parameters<typeof prepareCheckout>[3]> = {}, now = T0) =>
  prepareCheckout(db, rail, config, { ...customer, offerRef: "course:one", previewIdempotencyKey: key, ...extra }, now);
const quote = async (key: string, extra: Partial<Parameters<typeof prepareCheckout>[3]> = {}) => {
  const result = await preview(key, extra);
  if (result.state !== "PRICE_REVIEW_REQUIRED") throw new Error(`expected a quote, got ${result.state}`);
  return result;
};
const confirm = (quoteId: string, key = "pay", now = at(1)) => confirmCheckout(db, rail, config, { ...customer, quoteId, idempotencyKey: key }, now);
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const intent = () => db.prepare("SELECT state,failure_code,consumed_at,storefront_open_since FROM checkout_quotes").get() as
  { state: string; failure_code: string | null; consumed_at: string | null; storefront_open_since: number | null };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new MockPaymentRail();
  beforeRead = undefined;
  refusals = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    try { const event = JSON.parse(String(line)); if (event.event === "SALES_STOP_REFUSAL") refusals.push(event); } catch { /* not ours */ }
  });
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("reading the switch: anything but a valid, current, OPEN document is CLOSED", () => {
  const document = () => testStorefrontSwitchDocument(db);
  const reading = () => readStorefrontSwitch(db, config, { now: T0 });

  it.each([
    ["no source at all", undefined, "SOURCE_NOT_CONFIGURED"],
    ["an unreadable file", new Error("EACCES"), "UNREADABLE"],
    ["not JSON", "{", "INVALID"],
    ["an unknown field", () => JSON.stringify({ ...document(), extra: true }), "INVALID"],
    ["an unknown state", () => JSON.stringify({ ...document(), storefronts: { ...document().storefronts, LAB: { state: "PAUSED" } } }), "INVALID"],
    ["an opening after its own generation", () => JSON.stringify({ ...document(), storefronts: { ...document().storefronts, LAB: { state: "OPEN", openSince: 9 } } }), "INVALID"],
    ["a missing evidence issue", () => JSON.stringify({ ...document(), evidenceIssue: "" }), "INVALID"],
    ["another scope", () => JSON.stringify({ ...document(), scope: "production" }), "SCOPE_MISMATCH"],
    ["an oversized file", () => JSON.stringify({ ...document(), reason: "x".repeat(5000) }), "INVALID"],
  ] as const)("refuses %s", (_case, raw, reason) => {
    if (raw === undefined) {
      expect(readStorefrontSwitch(db, { deployEnvironment: "test" })).toEqual({ available: false, reason });
      return;
    }
    setTestStorefrontSwitchRaw(db, typeof raw === "function" ? raw() : raw);
    expect(reading()).toEqual({ available: false, reason });
    expect(() => assertStorefrontOpen(db, config, "COURSES", "NEW_QUOTE")).toThrow(SalesStoppedError);
  });

  it("refuses a file restored to an older generation, and a generation reused for other content, across restarts", () => {
    setTestStorefronts(db, { LAB: "CLOSED" });
    const older = JSON.stringify(document());
    setTestStorefronts(db, { COURSES: "CLOSED" });
    const stopped = document();
    expect(reading()).toMatchObject({ available: true, document: { generation: 3 } });
    // The owner's stop at generation 3 replaced by the earlier OPEN document (a backup, a replay).
    setTestStorefrontSwitchRaw(db, older);
    expect(reading()).toEqual({ available: false, reason: "GENERATION_REGRESSED" });
    // Generation 3 again, but saying OPEN: refused, it is not what generation 3 was.
    setTestStorefrontSwitchRaw(db, JSON.stringify({ ...stopped, storefronts: { COURSES: { state: "OPEN", openSince: 1 }, LAB: { state: "CLOSED" } } }));
    expect(reading()).toEqual({ available: false, reason: "GENERATION_REUSED" });
  });

  it("still refuses the older file after a restart over the same database file", () => {
    const folder = mkdtempSync(join(tmpdir(), "fx-switch-restart-"));
    const path = join(folder, "commerce.sqlite");
    try {
      const older = JSON.stringify({ ...testStorefrontSwitchDocument(db), generation: 4,
        storefronts: { COURSES: { state: "OPEN", openSince: 4 }, LAB: { state: "OPEN", openSince: 4 } } });
      const stop = JSON.stringify({ ...testStorefrontSwitchDocument(db), generation: 5, storefronts: { COURSES: { state: "CLOSED" }, LAB: { state: "CLOSED" } } });
      let raw = stop;
      const fileConfig = { deployEnvironment: "test" as const, storefrontSwitch: () => raw };
      const first = new Database(path); migrateV2(first);
      expect(readStorefrontSwitch(first, fileConfig).available).toBe(true);
      first.close();
      const restarted = new Database(path);
      raw = older;
      expect(readStorefrontSwitch(restarted, fileConfig)).toEqual({ available: false, reason: "GENERATION_REGRESSED" });
      restarted.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it("keeps observations append-only, and an emptied observation store still opens nothing by itself", () => {
    setTestStorefronts(db, { COURSES: "CLOSED" });
    reading();
    expect(() => db.prepare("DELETE FROM storefront_switch_observations").run()).toThrow("STOREFRONT_SWITCH_OBSERVATION_IMMUTABLE");
    expect(() => db.prepare("UPDATE storefront_switch_observations SET courses_state='OPEN',courses_open_since=1").run())
      .toThrow("STOREFRONT_SWITCH_OBSERVATION_IMMUTABLE");
    // A reset database (the runtime's only writable authority) keeps the host file's CLOSED.
    const reset = new Database(":memory:");
    try {
      reset.pragma("foreign_keys = ON"); migrateV2(reset);
      expect(() => assertStorefrontOpen(reset, { deployEnvironment: "test", storefrontSwitch: () => JSON.stringify(document()) }, "COURSES", "NEW_QUOTE"))
        .toThrow(SalesStoppedError);
    } finally { reset.close(); }
  });

  it("is read on every admission, never cached", () => {
    expect(assertStorefrontOpen(db, config, "COURSES", "NEW_QUOTE")).toEqual({ generation: 1, openSince: 1 });
    setTestStorefronts(db, { COURSES: "CLOSED" });
    expect(() => assertStorefrontOpen(db, config, "COURSES", "NEW_QUOTE")).toThrow("SALES_STOPPED");
    setTestStorefronts(db, { COURSES: "OPEN" });
    expect(assertStorefrontOpen(db, config, "COURSES", "NEW_QUOTE")).toEqual({ generation: 3, openSince: 3 });
    expect(refusals).toEqual([{ event: "SALES_STOP_REFUSAL", storefront: "COURSES", stage: "NEW_QUOTE", reason: "CLOSED", generation: 2 }]);
  });
});

describe("the host files: root-owned, read-only mounts, no runtime writer", () => {
  let root: string;
  let directory: string;
  let journalDirectory: string;
  const mountLine = (path: string, options: string) => `36 35 98:0 /host ${path} ${options} master:1 - ext4 /dev/root rw`;
  const mounted = (options = "ro,nosuid,nodev,noexec", journalOptions = options): string =>
    [mountLine(directory, options), mountLine(journalDirectory, journalOptions)].join("\n");
  const source = (mountInfo = mounted()): StorefrontSwitchSource =>
    hostStorefrontSwitchSource({ directory, journalDirectory, ownerUid: process.getuid!(), mountInfo: () => mountInfo });
  const sha = (body: string) => createHash("sha256").update(body).digest("hex");
  const unlocked = (folder: string, change: () => void) => { chmodSync(folder, 0o755); try { change(); } finally { chmodSync(folder, 0o555); } };
  const writeSwitch = (body: string) => unlocked(directory, () => {
    const temporary = join(directory, `.${STOREFRONT_SWITCH_FILE}.tmp`);
    writeFileSync(temporary, body, { mode: 0o444 });
    chmodSync(temporary, 0o444);
    renameSync(temporary, join(directory, STOREFRONT_SWITCH_FILE));
  });
  const appendJournal = (text: string) => unlocked(journalDirectory, () => {
    const file = join(journalDirectory, STOREFRONT_SWITCH_JOURNAL_FILE);
    try { chmodSync(file, 0o644); } catch { /* first record */ }
    appendFileSync(file, text);
    chmodSync(file, 0o444);
  });
  /** What the owner's tool does: the journal record first, then the switch file. */
  const write = (body: string) => {
    appendJournal(JSON.stringify({ generation: JSON.parse(body).generation, sha256: sha(body) }) + "\n");
    writeSwitch(body);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fx-storefront-switch-"));
    chmodSync(root, 0o755);
    directory = join(root, "switch");
    journalDirectory = join(root, "journal");
    mkdirSync(directory, { mode: 0o555 });
    mkdirSync(journalDirectory, { mode: 0o555 });
    chmodSync(directory, 0o555); chmodSync(journalDirectory, 0o555);
    write(JSON.stringify(testStorefrontSwitchDocument(db)));
  });
  afterEach(() => {
    // Every 0555 directory under the root, including the tool's own layout from the contract test:
    // without root, files in a read-only directory cannot be removed.
    const unlock = (folder: string) => {
      chmodSync(folder, 0o755);
      for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(folder, entry.name));
    };
    unlock(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the owner's atomic replacement through the mounted directories", () => {
    const host = { deployEnvironment: "test" as const, storefrontSwitch: source() };
    expect(assertStorefrontOpen(db, host, "COURSES", "NEW_QUOTE").generation).toBe(1);
    setTestStorefronts(db, { COURSES: "CLOSED" });
    write(JSON.stringify(testStorefrontSwitchDocument(db)));
    expect(() => assertStorefrontOpen(db, host, "COURSES", "NEW_QUOTE")).toThrow("SALES_STOPPED");
  });

  it("refuses an OPEN switch file restored over a stop this runtime never saw (review P1-1)", () => {
    const host = { deployEnvironment: "test" as const, storefrontSwitch: source() };
    // Generation 8: COURSES open, seen by this runtime.
    setTestStorefrontSwitchRaw(db, JSON.stringify({ ...testStorefrontSwitchDocument(db), generation: 8,
      storefronts: { COURSES: { state: "OPEN", openSince: 8 }, LAB: { state: "CLOSED" } } }));
    const open8 = config.storefrontSwitch(db);
    write(open8);
    expect(assertStorefrontOpen(db, host, "COURSES", "NEW_QUOTE").generation).toBe(8);
    // Generation 9: the owner's stop, written while Commerce is down, so never observed in SQLite.
    const closed9 = JSON.stringify({ ...JSON.parse(open8), generation: 9, storefronts: { COURSES: { state: "CLOSED" }, LAB: { state: "CLOSED" } } });
    write(closed9);
    // A restore puts the generation 8 copy back; the journal still ends at 9.
    writeSwitch(open8);
    expect(db.prepare("SELECT MAX(generation) AS g FROM storefront_switch_observations").get()).toEqual({ g: 8 });
    expect(readStorefrontSwitch(db, host)).toEqual({ available: false, reason: "JOURNAL_MISMATCH" });
    expect(() => assertStorefrontOpen(db, host, "COURSES", "NEW_QUOTE")).toThrow("SALES_STOPPED");
    expect(refusals.at(-1)).toMatchObject({ stage: "NEW_QUOTE", reason: "JOURNAL_MISMATCH" });
    // The reverse: the journal restored to before the stop while the switch says 9.
    writeSwitch(closed9);
    unlocked(journalDirectory, () => { rmSync(join(journalDirectory, STOREFRONT_SWITCH_JOURNAL_FILE)); });
    appendJournal(JSON.stringify({ generation: 8, sha256: sha(open8) }) + "\n");
    expect(readStorefrontSwitch(db, host)).toEqual({ available: false, reason: "JOURNAL_MISMATCH" });
  });

  it("requires the journal record's generation as well as its digest", () => {
    const host = { deployEnvironment: "test" as const, storefrontSwitch: source() };
    const current = readFileSync(join(directory, STOREFRONT_SWITCH_FILE), "utf8");
    appendJournal(JSON.stringify({ generation: 7, sha256: sha(current) }) + "\n");
    expect(readStorefrontSwitch(db, host)).toEqual({ available: false, reason: "JOURNAL_MISMATCH" });
    appendJournal(JSON.stringify({ generation: 0, sha256: sha(current) }) + "\n");
    expect(readStorefrontSwitch(db, host)).toEqual({ available: false, reason: "JOURNAL_INVALID" });
    appendJournal(JSON.stringify({ generation: 1, sha256: sha(current) }) + "\n");
    expect(readStorefrontSwitch(db, host)).toMatchObject({ available: true, document: { generation: 1 } });
  });

  it.each([7, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true])("rejects journal generation %s even with the exact switch digest", (generation) => {
    const documentGeneration = generation === true ? 1 : 8;
    const body = JSON.stringify({ ...testStorefrontSwitchDocument(db), generation: documentGeneration,
      storefronts: { COURSES: { state: "OPEN", openSince: documentGeneration }, LAB: { state: "CLOSED" } } });
    write(body);
    appendJournal(JSON.stringify({ generation, sha256: sha(body) }) + "\n");
    const host = { deployEnvironment: "test" as const, storefrontSwitch: source() };
    expect(readStorefrontSwitch(db, host)).toEqual({ available: false,
      reason: generation === 7 ? "JOURNAL_MISMATCH" : "JOURNAL_INVALID" });
    // The Python authority must refuse the same on-disk state (including correct digest/wrong gen).
    const result = spawnSync("python3", ["-B", "-c", `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("tool", sys.argv[1]); tool = importlib.util.module_from_spec(spec); spec.loader.exec_module(tool)
current, error = tool.Layout(sys.argv[2], "local", os.getuid()).current()
print(json.dumps({"admitted": current is not None, "error": error}))`,
    join(__dirname, "..", "..", "scripts", "v2", "storefront-switch.py"), root], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ admitted: false, error: "SWITCH_JOURNAL_MISMATCH" });
  });

  it("ignores a torn last append but refuses a damaged last record", () => {
    const host = { deployEnvironment: "test" as const, storefrontSwitch: source() };
    appendJournal('{"generation":2,"sha2');
    expect(readStorefrontSwitch(db, host)).toMatchObject({ available: true, document: { generation: 1 } });
    appendJournal("\nnot a record\n");
    expect(readStorefrontSwitch(db, host)).toEqual({ available: false, reason: "JOURNAL_INVALID" });
  });

  it.each<[string, () => string, string | RegExp]>([
    ["the mount is missing (reboot before mount, image default)", () => "", "STOREFRONT_SWITCH_MOUNT_INVALID"],
    ["the mount is writable", () => mounted("rw,nosuid"), "STOREFRONT_SWITCH_MOUNT_INVALID"],
    ["the journal mount is missing", () => mountLine(directory, "ro"), "STOREFRONT_SWITCH_MOUNT_INVALID"],
    ["the journal mount is writable", () => mounted("ro", "rw"), "STOREFRONT_SWITCH_MOUNT_INVALID"],
    ["the directory is writable", () => { chmodSync(directory, 0o755); return mounted(); }, "STOREFRONT_SWITCH_DIRECTORY_INVALID"],
    ["the file is writable", () => { unlocked(directory, () => chmodSync(join(directory, STOREFRONT_SWITCH_FILE), 0o644)); return mounted(); }, "STOREFRONT_SWITCH_FILE_INVALID"],
    ["the journal is writable", () => { unlocked(journalDirectory, () => chmodSync(join(journalDirectory, STOREFRONT_SWITCH_JOURNAL_FILE), 0o644)); return mounted(); }, "STOREFRONT_SWITCH_FILE_INVALID"],
    ["the file is a symlink", () => {
      unlocked(directory, () => {
        renameSync(join(directory, STOREFRONT_SWITCH_FILE), join(root, "elsewhere.json"));
        symlinkSync(join(root, "elsewhere.json"), join(directory, STOREFRONT_SWITCH_FILE));
      });
      return mounted();
    }, "STOREFRONT_SWITCH_FILE_INVALID"],
    ["the file is missing", () => { unlocked(directory, () => rmSync(join(directory, STOREFRONT_SWITCH_FILE))); return mounted(); }, /ENOENT/],
    ["the journal is missing", () => { unlocked(journalDirectory, () => rmSync(join(journalDirectory, STOREFRONT_SWITCH_JOURNAL_FILE))); return mounted(); }, /ENOENT/],
  ])("is CLOSED when %s", (_case, damage, code) => {
    const mountInfo = damage();
    expect(() => source(mountInfo)(db)).toThrow(code);
    expect(readStorefrontSwitch(db, { deployEnvironment: "test", storefrontSwitch: source(mountInfo) })).toEqual({ available: false, reason: "UNREADABLE" });
  });

  it("admits exactly what the owner's host tool writes (scripts/v2/storefront-switch.py)", () => {
    const hostRoot = join(root, "sales");
    const run = (...argv: string[]) => {
      const result = spawnSync("python3", ["-B", "-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("tool", sys.argv[1]); tool = importlib.util.module_from_spec(spec); spec.loader.exec_module(tool)
import os
sys.exit(tool.main(sys.argv[2:], owner_uid=os.getuid()))`, join(__dirname, "..", "..", "scripts", "v2", "storefront-switch.py"),
      argv[0], "--scope", "canary", "--root", hostRoot, ...argv.slice(1), "--by", "owner", "--reason", "contract test", "--evidence", "ART-319"],
      { encoding: "utf8" });
      expect(result.status).toBe(0);
    };
    run("install");
    run("close", "--storefront", "ALL", "--min-generation", "6");
    directory = join(hostRoot, "switch");
    journalDirectory = join(hostRoot, "journal");
    const canary = { deployEnvironment: "staging" as const, storefrontSwitch: source() };
    expect(readStorefrontSwitch(db, canary)).toMatchObject({ available: true, document: { generation: 7, scope: "canary",
      storefronts: { COURSES: { state: "CLOSED" }, LAB: { state: "CLOSED" } } } });
    // The production runtime refuses a canary file.
    expect(readStorefrontSwitch(db, { ...canary, deployEnvironment: "production" })).toEqual({ available: false, reason: "SCOPE_MISMATCH" });
    // A restored older switch file after the tool's next stop is refused by the runtime too.
    const older = readFileSync(join(directory, STOREFRONT_SWITCH_FILE), "utf8");
    run("close", "--storefront", "ALL");
    writeSwitch(older);
    expect(readStorefrontSwitch(db, canary)).toEqual({ available: false, reason: "JOURNAL_MISMATCH" });
    // The tool's next close repairs it with a fresh generation the runtime admits.
    run("close", "--storefront", "ALL");
    expect(readStorefrontSwitch(db, canary)).toMatchObject({ available: true, document: { generation: 9 } });
  });

  // The runtime process runs as an unprivileged user (Dockerfile.commerce-v2: USER node). Root on the
  // host is the only writer. The kernel read-only mount is proven on the real image in CI
  // (scripts/ci/storefront-switch-fixture.sh); this proves the owner/mode layer alone already refuses.
  it.skipIf(process.getuid?.() !== 0)("cannot be changed, replaced or removed with the runtime's privileges", () => {
    const attempt = spawnSync(process.execPath, ["-e", `
      const fs = require("node:fs"), path = require("node:path");
      const [dir, file] = process.argv.slice(1);
      const tries = {
        overwrite: () => fs.writeFileSync(path.join(dir, file), "{}"),
        replace: () => fs.writeFileSync(path.join(dir, ".next"), "{}"),
        remove: () => fs.unlinkSync(path.join(dir, file)),
        chmod: () => fs.chmodSync(path.join(dir, file), 0o666),
        rename: () => fs.renameSync(path.join(dir, file), path.join(dir, "old.json")),
      };
      const result = {};
      for (const [name, run] of Object.entries(tries)) { try { run(); result[name] = "WRITTEN"; } catch (error) { result[name] = error.code; } }
      console.log(JSON.stringify(result));
    `, directory, STOREFRONT_SWITCH_FILE], { uid: 1000, gid: 1000, encoding: "utf8" });
    expect(attempt.status).toBe(0);
    const result = JSON.parse(attempt.stdout) as Record<string, string>;
    for (const outcome of Object.values(result)) expect(["EACCES", "EPERM"]).toContain(outcome);
    const journal = spawnSync(process.execPath, ["-e", `
      const fs = require("node:fs");
      try { fs.appendFileSync(process.argv[1], "{}\\n"); console.log("WRITTEN"); } catch (error) { console.log(error.code); }
    `, join(journalDirectory, STOREFRONT_SWITCH_JOURNAL_FILE)], { uid: 1000, gid: 1000, encoding: "utf8" });
    expect(["EACCES", "EPERM"]).toContain(journal.stdout.trim());
    expect(assertStorefrontOpen(db, { deployEnvironment: "test", storefrontSwitch: source() }, "COURSES", "NEW_QUOTE").generation).toBe(1);
  });
});

describe("every checkpoint refuses new paid money", () => {
  it("refuses a new quote before anything is written or sent to Refref", async () => {
    setTestStorefronts(db, { COURSES: "CLOSED" });
    const resolve = vi.spyOn(rail, "resolve");
    await expect(preview("new")).rejects.toThrow("SALES_STOPPED");
    expect(resolve).not.toHaveBeenCalled();
    expect(count("checkout_quotes")).toBe(0);
    expect(refusals.map((r) => r.stage)).toEqual(["NEW_QUOTE"]);
  });

  it("refuses the repeat preview of an issued quote and its confirmation", async () => {
    const issued = await quote("issued");
    setTestStorefronts(db, { COURSES: "CLOSED" });
    await expect(preview("issued")).rejects.toThrow("SALES_STOPPED");
    const create = vi.spyOn(rail, "create");
    await expect(confirm(issued.quoteId)).rejects.toThrow("SALES_STOPPED");
    expect(create).not.toHaveBeenCalled();
    expect(count("orders")).toBe(0);
    expect(refusals.map((r) => r.stage)).toEqual(["ISSUED_QUOTE", "CONFIRM"]);
  });

  it("refuses an ACCEPTANCE_ONLY offer too: the stop covers every paid offer", async () => {
    db.prepare(`UPDATE offers SET sale_mode='ACCEPTANCE_ONLY',acceptance_allowlist_json='["student@example.com"]'`).run();
    setTestStorefronts(db, { COURSES: "CLOSED" });
    await expect(preview("acceptance")).rejects.toThrow("SALES_STOPPED");
  });

  it("stops only the storefront it names", async () => {
    setTestStorefronts(db, { LAB: "CLOSED" });
    await expect(quote("courses-still-open")).resolves.toMatchObject({ state: "PRICE_REVIEW_REQUIRED" });
  });

  it("keeps an issued quote through a transient read failure of the same opening", async () => {
    const issued = await quote("transient");
    expect(intent().storefront_open_since).toBe(1);
    setTestStorefrontSwitchRaw(db, new Error("EIO"));
    await expect(confirm(issued.quoteId, "during-failure")).rejects.toThrow("SALES_STOPPED");
    // The same opening reads back: the quote is still the buyer's.
    setTestStorefronts(db, { LAB: "CLOSED" });
    await expect(confirm(issued.quoteId, "after-recovery")).resolves.toMatchObject({ state: "PAID" });
  });

  it("ends an issued quote when its storefront is stopped and reopened before confirmation", async () => {
    const second = await quote("reopened");
    setTestStorefronts(db, { COURSES: "CLOSED" });
    setTestStorefronts(db, { COURSES: "OPEN" });
    await expect(confirm(second.quoteId, "after-reopen", at(2))).rejects.toThrow("SALES_STOPPED");
    expect(refusals.at(-1)).toMatchObject({ stage: "CONFIRM", reason: "REOPENED_SINCE_QUOTE" });
  });
});

describe("race: a stop against a confirmation already under way", () => {
  // Confirmation reads the switch twice: inside the order transaction, then before the provider call.
  it("lands before the order transaction reads it: the transaction refuses, no order", async () => {
    const issued = await quote("race-1");
    stopOnRead(1);
    const create = vi.spyOn(rail, "create");
    await expect(confirm(issued.quoteId)).rejects.toThrow("SALES_STOPPED");
    expect(create).not.toHaveBeenCalled();
    expect(count("orders")).toBe(0);
    expect(intent()).toMatchObject({ state: "REVIEW", consumed_at: null });
    expect(refusals.map((r) => r.stage)).toEqual(["CONFIRM"]);
  });

  it("lands after the order committed, before the provider call: nothing leaves Commerce and nothing is uncertain", async () => {
    const issued = await quote("race-3");
    stopOnRead(2);
    const create = vi.spyOn(rail, "create");
    await expect(confirm(issued.quoteId)).rejects.toThrow("SALES_STOPPED");
    expect(create).not.toHaveBeenCalled();
    expect(refusals.map((r) => r.stage)).toEqual(["PAYMENT_INITIATION"]);
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "CANCELLED" });
    const attempt = db.prepare("SELECT state,refref_attempt_id,observed_payment_projection_json FROM checkout_attempts").get() as
      { state: string; refref_attempt_id: string | null; observed_payment_projection_json: string };
    expect(attempt).toMatchObject({ state: "DECLINED", refref_attempt_id: null });
    expect(JSON.parse(attempt.observed_payment_projection_json)).toEqual({ stage: "PAYMENT_INITIATION_STOPPED", code: "SALES_STOPPED", externalAttemptAbsent: true });
    expect(intent()).toMatchObject({ state: "DECLINED", failure_code: "SALES_STOPPED" });
    // Nothing for reconciliation to chase, and a reopen does not revive it.
    setTestStorefronts(db, { COURSES: "OPEN" });
    expect(await reconcilePendingCheckouts(db, rail, at(10), config)).toEqual({ selected: 0, reconciled: 0, failed: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("stops the initial session POST after the attempt POST was already in flight", async () => {
    const issued = await quote("initial-two-posts");
    let finishAttempt!: (response: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishAttempt = resolve; }));
    const realRail = new RefrefPaymentRail({ apiBaseUrl: "https://synthetic.test/v1-rc", apiKey: "synthetic", merchantId: "synthetic", fetch: request });
    const payment = confirmCheckout(db, realRail, config, { ...customer, quoteId: issued.quoteId,
      idempotencyKey: "initial-two-posts", successUrl: "https://synthetic.test/return" }, at(1));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(new URL(String(request.mock.calls[0][0])).pathname).toMatch(/checkout-attempts$/);
    setTestStorefronts(db, { COURSES: "CLOSED" });
    const input = JSON.parse((db.prepare("SELECT request_payload_json FROM checkout_attempts").get() as { request_payload_json: string }).request_payload_json);
    finishAttempt(new Response(JSON.stringify({ checkoutAttemptId: "external-attempt", snapshotHash: input.snapshotHash, obligations: [] }), { status: 201 }));
    await expect(payment).resolves.toMatchObject({ state: "CREATE_UNKNOWN" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT state,refref_attempt_id,observed_payment_projection_json FROM checkout_attempts").get())
      .toEqual({ state: "CREATE_UNKNOWN", refref_attempt_id: "external-attempt", observed_payment_projection_json: null });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "PAYMENT_PENDING" });
  });

  it("lands while the provider call is in flight: the accepted payment is fulfilled and acknowledged", async () => {
    const issued = await quote("race-4");
    const original = rail.create.bind(rail);
    vi.spyOn(rail, "create").mockImplementation(async (input) => { setTestStorefronts(db, { COURSES: "CLOSED" }); return original(input); });
    await expect(confirm(issued.quoteId, "in-flight")).resolves.toMatchObject({ state: "PAID" });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "FULFILLED" });
    expect(count("course_entitlements")).toBe(1);
    expect(rail.fulfillmentAcknowledgementCount("in-flight")).toBe(1);
  });
});

describe("a stop never stops money already taken", () => {
  it("keeps reconciling a pending payment to fulfilment", async () => {
    const issued = await quote("late", { scenario: "late_payment" });
    expect(await confirm(issued.quoteId, "late")).toMatchObject({ state: "PENDING" });
    setTestStorefronts(db, { COURSES: "CLOSED" });
    expect(await reconcilePendingCheckouts(db, rail, at(2), config)).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "FULFILLED" });
    expect(count("course_entitlements")).toBe(1);
  });

  it("settles an ambiguous create that reached Refref by read-back, without a new create", async () => {
    const issued = await quote("ambiguous", { scenario: "ambiguous_create" });
    expect(await confirm(issued.quoteId, "ambiguous")).toMatchObject({ state: "CREATE_UNKNOWN" });
    setTestStorefronts(db, { COURSES: "CLOSED" });
    const create = vi.spyOn(rail, "create");
    expect(await reconcileCheckout(db, rail, (db.prepare("SELECT public_id FROM orders").get() as { public_id: string }).public_id, at(2), config))
      .toMatchObject({ state: "PAID" });
    expect(create).not.toHaveBeenCalled();
    expect(count("course_entitlements")).toBe(1);
  });

  it("does not re-send a create Refref never saw while stopped; it waits, and resumes identically after the reopen", async () => {
    const issued = await quote("crash");
    const original = rail.create.bind(rail);
    const create = vi.spyOn(rail, "create").mockRejectedValueOnce(new Error("process stopped")).mockImplementation(async (input) => original(input));
    await expect(confirm(issued.quoteId, "crash")).rejects.toThrow("process stopped");
    setTestStorefronts(db, { COURSES: "CLOSED" });
    expect(await reconcilePendingCheckouts(db, rail, at(3), config)).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT state FROM checkout_attempts").get()).toEqual({ state: "CREATING" });
    expect(refusals.at(-1)).toMatchObject({ stage: "PAYMENT_RECOVERY", reason: "CLOSED" });
    // Without the switch at all, recovery is read-back only too.
    expect(await reconcilePendingCheckouts(db, rail, at(4))).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    setTestStorefronts(db, { COURSES: "OPEN" });
    expect(await reconcilePendingCheckouts(db, rail, at(5), config)).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "FULFILLED" });
  });

  it.each(["absent order", "empty order", "existing attempt", "known attempt"])("GET → CLOSE keeps %s uncertain without any POST", async (scenario) => {
    const issued = await quote("delayed-read");
    vi.spyOn(rail, "create").mockRejectedValueOnce(new Error("lost create"));
    await expect(confirm(issued.quoteId, "delayed-read")).rejects.toThrow("lost create");
    db.prepare("UPDATE checkout_attempts SET state='CREATE_UNKNOWN'").run();
    const local = db.prepare("SELECT request_payload_json FROM checkout_attempts").get() as { request_payload_json: string };
    const input = { ...JSON.parse(local.request_payload_json), successUrl: "https://synthetic.test/return" };
    db.prepare("UPDATE checkout_attempts SET request_payload_json=?").run(JSON.stringify(input));
    const external = { id: "external-attempt", status: "OPEN", referralResolutionId: input.quote.resolutionId,
      snapshotHash: input.snapshotHash, lineItems: [], obligations: [{ obligationRef: "full", status: "OUTSTANDING", payment: null }] };
    if (scenario === "known attempt") db.prepare("UPDATE checkout_attempts SET refref_attempt_id=?").run(external.id);
    let finishGet!: (response: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishGet = resolve; }));
    const realRail = new RefrefPaymentRail({ apiBaseUrl: "https://synthetic.test/v1-rc", apiKey: "synthetic", merchantId: "synthetic", fetch: request });
    const order = (db.prepare("SELECT public_id FROM orders").get() as { public_id: string }).public_id;
    const recovery = reconcileCheckout(db, realRail, order, at(3), config);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.method).toBe("GET");
    setTestStorefronts(db, { COURSES: "CLOSED" });
    const body = scenario === "absent order" ? { error: { code: "NOT_FOUND" } }
      : scenario === "known attempt" ? external
        : { checkoutAttempts: scenario === "empty order" ? [] : [external] };
    finishGet(new Response(JSON.stringify(body), { status: scenario === "absent order" ? 404 : 200 }));
    await expect(recovery).resolves.toMatchObject({ state: "CREATE_UNKNOWN" });
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
    expect(db.prepare("SELECT state,observed_payment_projection_json FROM checkout_attempts").get())
      .toMatchObject({ state: "CREATE_UNKNOWN", observed_payment_projection_json: null });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "PAYMENT_PENDING" });
    expect(refusals.at(-1)).toMatchObject({ stage: "PAYMENT_RECOVERY", reason: "CLOSED" });
    // Refusal did not demote recovery to ordinary PENDING: after reopen it can still create the session.
    setTestStorefronts(db, { COURSES: "OPEN" });
    request.mockResolvedValueOnce(new Response(JSON.stringify(scenario === "known attempt" ? external : { checkoutAttempts: [external] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "PAYMENT_READY", providerPaymentUrl: "https://synthetic.test/pay" })));
    await expect(reconcileCheckout(db, realRail, order, at(4), config)).resolves.toMatchObject({ state: "CUSTOMER_ACTION_REQUIRED" });
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "POST"]);
  });

  it("executes an approved refund while stopped", async () => {
    const keys: RefundEnvelopeKeyring = { currentKeyId: "k1", keys: { k1: Buffer.alloc(32, 1) } };
    const order = await checkout(db, rail, config, { ...customer, offerRef: "course:one", idempotencyKey: "paid" }, T0);
    setTestStorefronts(db, { COURSES: "CLOSED", LAB: "CLOSED" });
    const request = requestRefund(db, { customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund", reasonCode: "CUSTOMER_REQUEST" });
    decideRefund(db, request.requestPublicId, { outcome: "APPROVE", amountKopecks: 10_000, policyBasis: "offer", rationale: "approved", actor: "operator" });
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "SUCCEEDED" });
  });
});

describe("operator read-back, independent of readiness", () => {
  it("reports the switch in /readyz without making readiness depend on it, and still refuses checkout when not ready", async () => {
    setTestStorefronts(db, { COURSES: "CLOSED" });
    const server = (overrides: Partial<Parameters<typeof createCommerceV2App>[0]> = {}) => createCommerceV2App({ db, config,
      sourceCommit: "a".repeat(40), serviceToken: "token", paymentRail: rail, now: () => new Date(T0),
      authenticateCustomer: async () => "customer", ...overrides });
    const ready = await server().request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, capabilities: { salesSwitch: { state: "READ", generation: 2, COURSES: "CLOSED", LAB: "OPEN" } } });
    setTestStorefrontSwitchRaw(db, new Error("EIO"));
    expect(await (await server().request("/readyz")).json()).toMatchObject({ ok: true,
      capabilities: { salesSwitch: { state: "UNAVAILABLE", reason: "UNREADABLE", COURSES: "CLOSED", LAB: "CLOSED" } } });
    // Readiness failing for another reason changes nothing about the stop.
    const notReady = server({ probeRefref: async () => "unavailable" });
    expect((await notReady.request("/readyz")).status).toBe(503);
    const refused = await notReady.request("/v1/checkout/preview", { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "while-not-ready" }, body: JSON.stringify({ offerRef: "course:one" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: "SALES_STOPPED" });
  });

  it("reads back the runtime's view through the owner command, which can neither open nor close", () => {
    const source: StorefrontSwitchSource = (d) => config.storefrontSwitch(d);
    setTestStorefronts(db, { LAB: "CLOSED" });
    const status = runOwnerCommand(db, ["storefront-switch", "status"], undefined, { DEPLOY_ENV: "test" }, T0, source) as Record<string, unknown>;
    expect(status).toMatchObject({ state: "READ", generation: 2, COURSES: "OPEN", LAB: "CLOSED", changedBy: "owner", evidenceIssue: "ART-319",
      observed: [expect.objectContaining({ generation: 2, courses: "OPEN", lab: "CLOSED", firstObservedAt: T0 })] });
    for (const verb of ["open", "close", "resume"]) {
      expect(() => runOwnerCommand(db, ["storefront-switch", verb, "--actor", "owner"], undefined, { DEPLOY_ENV: "test" }, T0, source))
        .toThrow("OWNER_COMMAND_UNKNOWN");
    }
    // The server's default is the host mount; without one the owner sees CLOSED, not an error.
    expect(runOwnerCommand(db, ["storefront-switch", "status"], undefined, { DEPLOY_ENV: "test" }, T0))
      .toMatchObject({ state: "UNAVAILABLE", reason: "UNREADABLE", COURSES: "CLOSED", LAB: "CLOSED" });
    expect(loadCommerceRuntimeConfig({ NODE_ENV: "test" }).storefrontSwitch).toBeUndefined();
  });

  it("preflights an opening: Refref payments, an active legal release and a qualified fiscal policy for every selling offer", () => {
    const refref = { DEPLOY_ENV: "staging", PAYMENT_MODE: "refref", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-",
      REFREF_API_KEY: "k", REFREF_MERCHANT_SLUG: "flexperiment", REFREF_MERCHANT_ID: "00000000-0000-4000-8000-000000000001",
      REFREF_API_BASE_URL: "https://api.refref.ru/v1-rc", REFREF_CHECKOUT_ORIGIN: "https://checkout.refref.ru", REFREF_HANDOFF_STATE_SECRET: "s" };
    const preflight = (storefront: string, environment: Record<string, string> = refref) =>
      runOwnerCommand(db, ["storefront-switch", "preflight", storefront], undefined, environment, T0);
    expect(preflight("COURSES")).toEqual({ storefront: "COURSES", ready: true, failures: [], sellingOffers: 1, unqualifiedOffers: [] });
    expect(preflight("COURSES", { DEPLOY_ENV: "test", PAYMENT_MODE: "mock" })).toMatchObject({ ready: false, failures: ["PAYMENT_MODE_NOT_REFREF"] });
    expect(preflight("LAB")).toMatchObject({ ready: false, failures: ["LEGAL_RELEASE_REQUIRED"] });
    const policy = db.prepare("SELECT id FROM fiscal_policy_versions WHERE status='QUALIFIED'").get() as { id: string };
    retireFiscalPolicy(db, { policyId: policy.id, actor: "owner" }, T0);
    expect(preflight("COURSES")).toMatchObject({ ready: false, failures: ["FISCAL_POLICY_NOT_QUALIFIED"], unqualifiedOffers: ["course:one"] });
    expect(() => preflight("ALL")).toThrow("OWNER_COMMAND_ID_INVALID");
  });
});
