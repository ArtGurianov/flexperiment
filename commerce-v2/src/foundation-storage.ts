import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { databaseReady } from "./readiness";

type Context = { environment: "canary" | "production"; sourceCommit: string };
const guard = (db: Database.Database, context: Context) => {
  if (!databaseReady(db) || !/^[0-9a-f]{40}$/.test(context.sourceCommit)
    || !["canary", "production"].includes(context.environment)) throw new Error("FOUNDATION_STORAGE_CONTEXT_INVALID");
  if ((db.pragma("quick_check", { simple: true })) !== "ok") throw new Error("SQLITE_INTEGRITY_FAILED");
};

export function markDurability(db: Database.Database, context: Context) {
  guard(db, context);
  const id = randomUUID();
  db.prepare("INSERT INTO deployment_durability(id,environment,source_commit) VALUES (?,?,?)").run(id, context.environment, context.sourceCommit);
  return id;
}

export function verifyDurability(db: Database.Database, context: Context, id: string) {
  guard(db, context);
  const marker = db.prepare("SELECT environment,source_commit FROM deployment_durability WHERE id=?").get(id) as { environment: string; source_commit: string } | undefined;
  if (marker?.environment !== context.environment || marker.source_commit !== context.sourceCommit) throw new Error("SQLITE_DURABILITY_FAILED");
}

/** Consistent SQLite online backup. Never copy a live DB without its WAL. */
export async function backupFoundation(db: Database.Database, context: Context, directory: string, recipient: string,
  encrypt = (input: string, output: string, publicRecipient: string) => {
    execFileSync("age", ["-r", publicRecipient, "-o", output, input], { stdio: "ignore", timeout: 30_000 });
  }) {
  guard(db, context);
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error("BACKUP_RECIPIENT_INVALID");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = mkdtempSync(join(directory, ".snapshot-"));
  const output = join(directory, `${context.environment}-${context.sourceCommit}-${randomUUID()}.sqlite.age`);
  try {
    const snapshot = join(temporary, "commerce.sqlite");
    await db.backup(snapshot);
    chmodSync(snapshot, 0o600);
    encrypt(snapshot, output, recipient);
    chmodSync(output, 0o600);
    const size = statSync(output).size;
    if (size === 0) throw new Error("BACKUP_ENCRYPTION_FAILED");
    return { filename: output.split("/").pop()!, size, sha256: createHash("sha256").update(readFileSync(output)).digest("hex") };
  } catch {
    rmSync(output, { force: true });
    throw new Error("FOUNDATION_BACKUP_FAILED");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
