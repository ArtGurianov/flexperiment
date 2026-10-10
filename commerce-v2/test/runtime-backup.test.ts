import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupFoundation } from "../src/foundation-storage";
import { backupRuntime, openBackupSource } from "../src/backup-cli";
import { migrateV2, openV2Database } from "../src/db";

describe("normal/foundation independent read-only recovery", () => {
  it("backs up uncheckpointed WAL read-only and restores the exact schema/catalogue, without new DB facts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "v2-runtime-backup-"));
    const filename = join(directory, "live.sqlite");
    const writer = openV2Database(filename);
    let reader: Database.Database | undefined;
    let restored: Database.Database | undefined;
    try {
      migrateV2(writer);
      writer.pragma("wal_autocheckpoint = 0");
      writer.prepare("INSERT INTO cities(id,slug,title) VALUES (?,?,?)").run("actual-row", "fixture-city", "Fixture");
      const before = writer.prepare("SELECT * FROM cities ORDER BY id").all();
      const schema = writer.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      const key = join(directory, "key.txt");
      execFileSync("age-keygen", ["-o", key], { stdio: "ignore" }); chmodSync(key, 0o600);
      const recipient = execFileSync("age-keygen", ["-y", key], { encoding: "utf8" }).trim();
      reader = openBackupSource(filename);
      expect(reader.readonly).toBe(true);
      reader.pragma("query_only = ON");
      expect(() => reader!.prepare("INSERT INTO cities(id,slug,title) VALUES ('no','no','no')").run()).toThrow();
      const proof = await backupFoundation(reader, { environment: "canary", sourceCommit: "a".repeat(40) }, join(directory, "archives"), recipient);
      expect(readdirSync(join(directory, "archives"))).toEqual([proof.filename]);
      expect(readFileSync(join(directory, "archives", proof.filename)).includes(Buffer.from("actual-row"))).toBe(false);
      const copy = join(directory, "restored.sqlite");
      execFileSync("age", ["-d", "-i", key, "-o", copy, join(directory, "archives", proof.filename)], { stdio: "ignore" });
      restored = new Database(copy, { readonly: true, fileMustExist: true });
      expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
      expect(restored.prepare("SELECT * FROM cities ORDER BY id").all()).toEqual(before);
      expect(restored.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(schema);
      expect(writer.prepare("SELECT COUNT(*) AS n FROM deployment_durability").get()).toEqual({ n: 0 });
    } finally {
      restored?.close(); reader?.close(); writer.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not create a missing source DB", () => {
    const directory = mkdtempSync(join(tmpdir(), "v2-backup-missing-"));
    try {
      expect(() => openBackupSource(join(directory, "missing.sqlite"))).toThrow();
      expect(readdirSync(directory)).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([
    { COMMERCE_V2_ENVIRONMENT: "legacy" },
    { COMMERCE_V2_ENVIRONMENT: "canary", COMMERCE_V2_DATABASE_PATH: "/legacy.sqlite" },
    { COMMERCE_V2_ENVIRONMENT: "production", COMMERCE_V2_DATABASE_PATH: "/var/lib/flexperiment-v2/commerce.sqlite", COMMERCE_V2_BACKUP_PATH: "/foreign" },
  ])("refuses invalid operator context before opening a DB", async (environment) => {
    await expect(backupRuntime(environment)).rejects.toThrow(/V2_BACKUP_(ENVIRONMENT|PATH)_REQUIRED/);
  });
});
