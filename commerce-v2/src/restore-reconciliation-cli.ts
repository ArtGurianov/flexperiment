import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { readErasureVerificationKeys } from "./erasure-runtime";
import { prepareLibraryErasureRead } from "./erasure-library-read";
import { RefrefRestoreReader } from "./restore-refref-reader";
import { reconcileIsolatedRestore, restoreInventorySchema, verifyRestoreReport } from "./restore-reconciliation";

const path = z.string().max(1024).refine(isAbsolute);
const configurationSchema = z.object({ version: z.literal(1),
  isolation: z.literal("INDEPENDENT_RESTORE_RUNTIME_JOBS_MAIL_STOPPED"),
  sourceDatabase: path, outputDirectory: path, inventoryFile: path,
  keysFile: path, erasureReadConfigFile: path, apiBaseUrl: z.string().url(), apiKeyFile: path,
}).strict();
function assertPrivateFile(filename: string, maximum = 8 * 1024 * 1024) {
  const s = lstatSync(filename);
  if (!isAbsolute(filename) || !s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.()
    || (s.mode & 0o777) !== 0o600 || s.size < 1 || s.size > maximum) throw new Error("RESTORE_PRIVATE_FILE_REQUIRED");
}
function privateFile(filename: string, maximum = 8 * 1024 * 1024) {
  assertPrivateFile(filename, maximum); return readFileSync(filename);
}
function fileHash(filename: string) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024), fd = openSync(filename, "r");
  try { for (;;) { const size = readSync(fd, buffer); if (!size) break; hash.update(buffer.subarray(0, size)); } }
  finally { closeSync(fd); }
  return hash.digest("hex");
}
function isRuntimeSource(filename: string) {
  const liveRoot = "/var/lib/flexperiment-v2";
  const canonicalLiveRoot = existsSync(liveRoot) ? realpathSync(liveRoot) : join(realpathSync("/var"), "lib", "flexperiment-v2");
  const defaultDatabase = join(process.cwd(), "commerce-v2-data", "commerce.sqlite");
  return filename.startsWith(liveRoot) || filename.startsWith(canonicalLiveRoot) || filename === defaultDatabase
    || (existsSync(defaultDatabase) && filename === realpathSync(defaultDatabase));
}

/** Always copies a detached source into a NEW private directory. No default/live DB path or migration. */
export async function runRestoreReconciliation(configFile: string) {
  process.umask(0o077);
  const c = configurationSchema.parse(JSON.parse(privateFile(configFile, 64 * 1024).toString("utf8")));
  const inventory = restoreInventorySchema.parse(JSON.parse(privateFile(c.inventoryFile).toString("utf8")));
  if (isRuntimeSource(c.sourceDatabase)) throw new Error("RESTORE_ISOLATION_REQUIRED");
  const sourceDatabase = realpathSync(c.sourceDatabase);
  // Reject every alias, including symlinked parents; all later source I/O uses this exact canonical path.
  if (sourceDatabase !== c.sourceDatabase || isRuntimeSource(sourceDatabase)) throw new Error("RESTORE_ISOLATION_REQUIRED");
  assertPrivateFile(sourceDatabase, Number.MAX_SAFE_INTEGER);
  if (fileHash(sourceDatabase) !== inventory.backupSha256
    || existsSync(`${sourceDatabase}-wal`) || existsSync(`${sourceDatabase}-shm`)) throw new Error("RESTORE_BACKUP_IDENTITY_REFUSED");
  const output = lstatSync(c.outputDirectory);
  if (!output.isDirectory() || output.isSymbolicLink() || output.uid !== process.getuid?.() || (output.mode & 0o777) !== 0o700
    || realpathSync(c.outputDirectory) !== c.outputDirectory || c.outputDirectory.startsWith("/var/lib/flexperiment-v2")) throw new Error("RESTORE_ISOLATION_REQUIRED");
  const databasePath = join(c.outputDirectory, "reconciled.sqlite");
  const reportPath = join(c.outputDirectory, "reconciliation.json");
  if (existsSync(databasePath) || existsSync(reportPath)) throw new Error("RESTORE_OUTPUT_ALREADY_EXISTS");
  const keys = readErasureVerificationKeys(c.keysFile, inventory.scope);
  const library = prepareLibraryErasureRead({ file: c.erasureReadConfigFile, scope: inventory.scope, keys,
    forbiddenRoots: [dirname(sourceDatabase), c.outputDirectory] });
  let db: Database.Database | undefined;
  try {
    const reader = new RefrefRestoreReader({ apiBaseUrl: c.apiBaseUrl, apiKey: privateFile(c.apiKeyFile, 4096).toString("utf8").trim() });
    copyFileSync(sourceDatabase, databasePath, constants.COPYFILE_EXCL);
    // Bind the actual copied bytes too; a changing input is not a detached backup.
    if (fileHash(databasePath) !== inventory.backupSha256) throw new Error("RESTORE_BACKUP_IDENTITY_REFUSED");
    db = new Database(databasePath, { fileMustExist: true }); db.pragma("foreign_keys=ON");
    const report = await reconcileIsolatedRestore({ db, inventory, reader, keys, readErasure: library.read });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { state: report.state, reportSha256: report.reportSha256, runtimeAdmission: report.runtimeAdmission };
  } finally { db?.close(); library.close(); }
}

export function verifyRestoreReconciliation(reportFile: string) {
  const report = JSON.parse(privateFile(reportFile).toString("utf8"));
  const databasePath = join(dirname(reportFile), "reconciled.sqlite"); assertPrivateFile(databasePath, Number.MAX_SAFE_INTEGER);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try { db.pragma("query_only=ON"); return verifyRestoreReport(db, report); } finally { db.close(); }
}

if (process.argv[1]?.endsWith("/restore-reconciliation-cli.ts")) {
  (async () => {
    if (process.argv.length !== 4 || !["--config", "--verify"].includes(process.argv[2])) throw new Error("RESTORE_CONFIGURATION_INVALID");
    console.log(JSON.stringify(process.argv[2] === "--verify" ? verifyRestoreReconciliation(process.argv[3]) : await runRestoreReconciliation(process.argv[3])));
  })().catch(error => {
    // No SQL, customer rows, provider response bodies or credentials on stderr.
    console.error(error instanceof Error && /^(RESTORE|ERASURE)_[A-Z_]{1,100}$/.test(error.message) ? error.message : "RESTORE_RECONCILIATION_REFUSED");
    process.exitCode = 1;
  });
}
