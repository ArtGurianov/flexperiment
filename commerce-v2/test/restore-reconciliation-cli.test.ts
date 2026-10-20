import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import { VerifiedErasureLedger, issueErasureCheckpoint, type ErasureKeys } from "../src/erasure-ledger";
import * as libraryReader from "../src/erasure-library-read";
import { runRestoreReconciliation, verifyRestoreReconciliation } from "../src/restore-reconciliation-cli";

let root: string, source: string, output: string, config: string;
const originalUmask = process.umask();
const bytesHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "art-313-cli-")));
  const sourceDirectory = join(root, "source"); mkdirSync(sourceDirectory, { mode: 0o700 });
  output = join(root, "attempt"); mkdirSync(output, { mode: 0o700 }); source = join(sourceDirectory, "snapshot.sqlite");
  const db = new Database(join(sourceDirectory, "original.sqlite")); db.pragma("foreign_keys=ON"); migrateV2(db);
  db.exec(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one');
    INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC');`);
  try { await db.backup(source); } finally { db.close(); } chmodSync(source, 0o600);
  const privateJson = (name: string, value: unknown) => { const file = join(root, name);
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return file; };
  const pair = generateKeyPairSync("ed25519"), subject = randomBytes(32);
  const keys: ErasureKeys = { signing: { k: pair.publicKey }, subject: { k: subject } };
  const signer = { keyId: "k", privateKey: pair.privateKey }, bundle = { version: 1 as const, scope: "canary" as const, entries: [] };
  // Real key parsing + genuine verified capability. This seam replaces only remote Cloud.ru transport;
  // these local CLI tests do not claim real custody or tenant/provider qualification.
  vi.spyOn(libraryReader, "prepareLibraryErasureRead").mockReturnValue({ bindingSha256: "a".repeat(64), close: vi.fn(),
    read: () => VerifiedErasureLedger.read({ scope: "canary", bundle, keys,
      readCurrentCheckpoint: async nonce => issueErasureCheckpoint(bundle, nonce, signer, keys) }) });
  const keysFile = privateJson("keys.json", { version: 1, scope: "canary", signing: { k: pair.publicKey.export({ format: "pem", type: "spki" }) },
    subject: { k: subject.toString("base64") } });
  const inventoryFile = privateJson("inventory.json", { version: 1, scope: "canary", merchantId: "merchant",
    backupSha256: bytesHash(source), sourceEvidenceSha256: "b".repeat(64), completeThrough: new Date().toISOString(), orders: [] });
  const apiKeyFile = join(root, "api-key"); writeFileSync(apiKeyFile, "synthetic-key", { mode: 0o600 });
  config = privateJson("config.json", { version: 1, isolation: "INDEPENDENT_RESTORE_RUNTIME_JOBS_MAIL_STOPPED",
    sourceDatabase: source, outputDirectory: output, inventoryFile, keysFile, erasureReadConfigFile: join(root, "remote-reader.json"),
    apiBaseUrl: "https://canary-api.example.test/v1-rc", apiKeyFile });
});
afterEach(() => { process.umask(originalUmask); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("one-shot recovery CLI isolation and reopened read-back", () => {
  it("keeps source bytes unchanged and creates a private closed result whose report verifies after reopen", async () => {
    const sourceHash = bytesHash(source); const result = await runRestoreReconciliation(config);
    expect(result).toMatchObject({ state: "RECONCILED_CLOSED", runtimeAdmission: "PENDING" });
    expect(bytesHash(source)).toBe(sourceHash);
    expect(verifyRestoreReconciliation(join(output, "reconciliation.json"))).toEqual({
      state: "LOCAL_READBACK_VERIFIED", reportSha256: result.reportSha256, runtimeAdmission: "PENDING" });
    await expect(runRestoreReconciliation(config)).rejects.toThrow("RESTORE_OUTPUT_ALREADY_EXISTS");
    expect(bytesHash(source)).toBe(sourceHash);
  });
  it.each(["hash", "wal", "permissions", "output-permissions", "live-path"])("refuses %s before copying a backup", async reason => {
    if (reason === "hash") {
      const file = join(root, "inventory.json"), inventory = JSON.parse(readFileSync(file, "utf8"));
      inventory.backupSha256 = "f".repeat(64); writeFileSync(file, JSON.stringify(inventory));
    }
    if (reason === "wal") writeFileSync(`${source}-wal`, "unclassified-sidecar");
    if (reason === "permissions") chmodSync(source, 0o644);
    if (reason === "output-permissions") chmodSync(output, 0o755);
    if (reason === "live-path") { const c = JSON.parse(readFileSync(config, "utf8"));
      c.sourceDatabase = "/var/lib/flexperiment-v2/commerce.sqlite"; writeFileSync(config, JSON.stringify(c)); }
    await expect(runRestoreReconciliation(config)).rejects.toThrow(/RESTORE_/);
    expect(existsSync(join(output, "reconciled.sqlite"))).toBe(false);
  });
  it("rejects a modified report and a modified recovered database", async () => {
    await runRestoreReconciliation(config); const file = join(output, "reconciliation.json");
    const original = readFileSync(file), report = JSON.parse(original.toString("utf8"));
    report.remoteSha256 = "f".repeat(64); writeFileSync(file, JSON.stringify(report));
    expect(() => verifyRestoreReconciliation(file)).toThrow("RESTORE_READBACK_FAILED"); writeFileSync(file, original);
    const db = new Database(join(output, "reconciled.sqlite"));
    try { db.exec("INSERT INTO customers(id,email_normalized) VALUES ('unexpected','unexpected@example.test')"); } finally { db.close(); }
    expect(() => verifyRestoreReconciliation(file)).toThrow("RESTORE_READBACK_FAILED");
  });
  it.each(["parent-directory", "file"])("refuses a source alias through a symlinked %s before copying or reading custody", async kind => {
    const sourceHash = bytesHash(source), alias = join(root, "source-alias");
    symlinkSync(kind === "parent-directory" ? dirname(source) : source, alias, kind === "parent-directory" ? "dir" : "file");
    const c = JSON.parse(readFileSync(config, "utf8"));
    c.sourceDatabase = kind === "parent-directory" ? join(alias, basename(source)) : alias;
    writeFileSync(config, JSON.stringify(c));
    await expect(runRestoreReconciliation(config)).rejects.toThrow("RESTORE_ISOLATION_REQUIRED");
    expect(existsSync(join(output, "reconciled.sqlite"))).toBe(false);
    expect(libraryReader.prepareLibraryErasureRead).not.toHaveBeenCalled(); expect(bytesHash(source)).toBe(sourceHash);
  });
});
