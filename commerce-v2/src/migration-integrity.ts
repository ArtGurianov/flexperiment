import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const v2MigrationsDirectory = () => join(process.cwd(), "commerce-v2", "migrations");
export const migrationSha256 = (sql: string | Buffer) => createHash("sha256").update(sql).digest("hex");
export type V2Migration = { version: string; sha256: string; sql: string };

export class V2MigrationIntegrityError extends Error {
  constructor(readonly code: string, readonly version?: string) {
    super(version ? `${code}: ${version}` : code);
    this.name = "V2MigrationIntegrityError";
  }
}

export function readV2MigrationLock(text: string): Record<string, string> {
  let lock;
  try { lock = JSON.parse(text); } catch { throw new V2MigrationIntegrityError("V2_MIGRATION_LOCK_INVALID"); }
  if (lock?.version !== 1 || lock?.lineage !== "flexperiment-v2" || !lock.migrations
    || typeof lock.migrations !== "object" || Array.isArray(lock.migrations)) {
    throw new V2MigrationIntegrityError("V2_MIGRATION_LOCK_INVALID");
  }
  const entries = Object.entries(lock.migrations);
  if (!entries.length || entries.some(([version, digest], index) =>
    !/^\d{4}_[a-z0-9_]+\.sql$/.test(version) || !version.startsWith(`${String(index + 1).padStart(4, "0")}_`)
    || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
    throw new V2MigrationIntegrityError("V2_MIGRATION_LOCK_INVALID");
  }
  return lock.migrations;
}

/** Read and verify the entire bundle before opening any migration transaction. */
export function readV2Migrations(directory = v2MigrationsDirectory()): V2Migration[] {
  if (!existsSync(directory)) throw new V2MigrationIntegrityError("V2_MIGRATIONS_DIRECTORY_MISSING");
  const lockPath = join(directory, "migration.lock");
  if (!existsSync(lockPath)) throw new V2MigrationIntegrityError("V2_MIGRATION_LOCK_MISSING");
  const lock = readV2MigrationLock(readFileSync(lockPath, "utf8"));
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(lock))) {
    throw new V2MigrationIntegrityError("V2_MIGRATION_FILE_SET_MISMATCH");
  }
  return files.map((version) => {
    const bytes = readFileSync(join(directory, version));
    const sql = bytes.toString("utf8");
    if (migrationSha256(bytes) !== lock[version] || migrationSha256(sql) !== lock[version]) {
      throw new V2MigrationIntegrityError("V2_MIGRATION_SQL_DIGEST_MISMATCH", version);
    }
    return { version, sql, sha256: lock[version] };
  });
}

// The pre-digest deployment chain at dc351af2 (0001–0032). Never extend this
// allowance for migrations introduced after ART-316; they must have stored hashes.
const LEGACY_MIGRATION_COUNT = 32;
const LEGACY_CHAIN_SHA256 = "4c0411484a2303621fc28be88d876154c37a2815f3c4af88b05d6e2c8876023e";

export function assertV2LegacyUpgradeChain(migrations: V2Migration[], appliedCount: number) {
  const chain = migrations.slice(0, LEGACY_MIGRATION_COUNT).map(({ version, sha256 }) => [version, sha256]);
  if (appliedCount > LEGACY_MIGRATION_COUNT || chain.length !== LEGACY_MIGRATION_COUNT
    || migrationSha256(JSON.stringify(chain)) !== LEGACY_CHAIN_SHA256) {
    throw new V2MigrationIntegrityError("V2_LEGACY_MIGRATION_CHAIN_UNTRUSTED");
  }
}
