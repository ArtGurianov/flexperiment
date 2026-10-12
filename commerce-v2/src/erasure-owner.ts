import Database from "better-sqlite3";
import { createPrivateKey, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { ErasureCustodian, ageCustodyEncryption } from "./erasure-custody";
import { createErasureS3Custody } from "./erasure-custody-s3";
import { ErasureLedgerError, ErasureLedgerStore, VerifiedErasureLedger, readOwnerErasureBundle } from "./erasure-ledger";
import { ErasureRuntimeFence, DrainedErasureRuntime } from "./erasure-fence";
import { ErasureInstallationEvidence, readErasureInstallation } from "./erasure-installation";
import { admitVerifiedErasure, readErasureVerificationKeys } from "./erasure-runtime";
import { createCurrentErasureRead, createErasureCurrentObjects, erasureReaderBinding, type ErasureReadConfiguration } from "./erasure-library-read";
import { applyDrainedRuntimeErasure } from "./erasure-restore";
import { VerifiedErasureRequest } from "./erasure-request";
import { createAuthRuntime } from "./auth";
import { classifyV2Database } from "./db";

const file = z.string().max(1024).refine(isAbsolute);
const allowedOrigins = ["https://canary-platform.flexperiment.ru", "https://canary-lab.flexperiment.ru", "https://canary-admin.flexperiment.ru", "https://canary-api.flexperiment.ru"];
const configurationSchema = z.object({ version: z.literal(1), scope: z.literal("canary"),
  databasePath: file, ledgerDirectory: file, fenceDirectory: file, mirrorFile: file, keysFile: file,
  signer: z.object({ keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), privateKeyFile: file }).strict(),
  subjectKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  recipient: z.string().regex(/^age1[0-9a-z]{58}$/),
  remote: z.object({ endpoint: z.literal("https://s3.cloud.ru"), region: z.literal("ru-central-1"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    expectedBucketOwner: z.string().regex(/^[^\r\n]{1,128}$/),
    readAccessKeyFile: file, readSecretKeyFile: file, writeAccessKeyFile: file, writeSecretKeyFile: file }).strict(),
  authEnvironmentFile: file.optional(),
}).strict();
export type ErasureOwnerConfiguration = z.infer<typeof configurationSchema>;
const plainOperation = z.object({ operation: z.enum(["inspect", "initialize-fence", "initialize-custody", "resume-initialization", "recover-ledger", "read", "publish-pending", "reconcile"]) }).strict();
const admitOperation = z.object({ operation: z.literal("admit"), requestId: z.string().uuid(),
  headers: z.object({ origin: z.enum(allowedOrigins as [string, ...string[]]), cookie: z.string().min(1).max(16_384) }).strict() }).strict();
const operationSchema = z.union([plainOperation, admitOperation]);
function refuse(code = "ERASURE_OWNER_CONFIGURATION_INVALID"): never { throw new ErasureLedgerError(code); }

export function readOwnerPrivateFile(path: string, maxBytes = 64 * 1024) {
  try {
    if (!isAbsolute(path)) refuse(); const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.()
      || (s.mode & 0o777) !== 0o600 || s.size < 1 || s.size > maxBytes) refuse();
    return readFileSync(path, "utf8");
  } catch { return refuse(); }
}
export function readOwnerConfiguration(path: string) {
  try { return configurationSchema.parse(JSON.parse(readOwnerPrivateFile(path))); }
  catch { return refuse(); }
}

/** Atomically publish the EXISTING bundle format after remote ACK, while drained.
 * This is a read-only runtime mirror, not a second ledger or a local durability ACK. */
export function publishErasureReadMirror(path: string, proof: VerifiedErasureLedger, drain: DrainedErasureRuntime,
  db: Database.Database, now = new Date()) {
  proof.assertFresh(now); DrainedErasureRuntime.assert(drain, db, proof.bundle.scope);
  const directory = dirname(path); const s = lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) refuse();
  if (existsSync(path)) { const p = lstatSync(path);
    if (!p.isFile() || p.isSymbolicLink() || p.nlink !== 1 || p.uid !== s.uid || (p.mode & 0o777) !== 0o600) refuse(); }
  const bytes = JSON.stringify(proof.bundle); if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) refuse("ERASURE_CUSTODY_CAPACITY_REVIEW_REQUIRED");
  const temporary = join(directory, `.erasure-export-${randomUUID()}`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    const fd = openSync(temporary, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Small explicit owner operations. No daemon, HTTP endpoint, key generation,
 * migration, arbitrary SQL, lease clearing or automatic crash repair. */
export async function runErasureOwnerOperation(value: unknown, operation: unknown, options?: {
  installation?: ErasureInstallationEvidence; requestHandler?: S3ClientConfig["requestHandler"]; now?: () => Date;
}) {
  const parsed = configurationSchema.safeParse(value); const action = operationSchema.safeParse(operation);
  if (!parsed.success || !action.success) refuse();
  const c = parsed.data; const op = action.data; const now = options?.now ?? (() => new Date());
  const environment = { DEPLOY_ENV: "staging", ERASURE_SCOPE: "canary", ERASURE_FENCING_ENABLED: "true", ERASURE_FENCE_DIRECTORY: c.fenceDirectory };
  if (op.operation === "inspect") {
    let policy = "UNVERIFIED";
    try { const evidence = options?.installation ?? readErasureInstallation(environment);
      ErasureInstallationEvidence.assertRuntime(evidence, environment); policy = evidence.policy.state; } catch { /* Diagnostic, not admission. */ }
    return { operation: op.operation, scope: c.scope, policy,
      fencePresent: existsSync(join(c.fenceDirectory, "erasure-fence.sqlite")),
      ledgerPresent: existsSync(join(c.ledgerDirectory, "erasure-ledger.sqlite")), mirrorPresent: existsSync(c.mirrorFile) };
  }
  const installation = options?.installation ?? readErasureInstallation(environment);
  ErasureInstallationEvidence.assertRuntime(installation, environment);
  const keys = readErasureVerificationKeys(c.keysFile, c.scope);
  if (keys.subject[c.subjectKeyId]?.length !== 32) refuse("ERASURE_SUBJECT_KEY_MISSING");
  const forbiddenRoots = [dirname(c.databasePath), c.fenceDirectory, dirname(c.mirrorFile)];
  const recipientSha256 = ageCustodyEncryption(c.recipient).recipientSha256;
  const readerConfiguration: ErasureReadConfiguration = { version: 1, scope: c.scope, endpoint: c.remote.endpoint, region: c.remote.region,
    bucket: c.remote.bucket, expectedBucketOwner: c.remote.expectedBucketOwner, prefix: `flexperiment/erasure/${c.scope}/`, bundleFile: c.mirrorFile, recipientSha256,
    accessKeyId: readOwnerPrivateFile(c.remote.readAccessKeyFile).trim(), secretAccessKey: readOwnerPrivateFile(c.remote.readSecretKeyFile).trim() };
  ErasureInstallationEvidence.assertReaderBinding(installation, erasureReaderBinding(readerConfiguration));
  const remote = createErasureCurrentObjects(readerConfiguration, options?.requestHandler);
  const readCurrent = createCurrentErasureRead({ scope: c.scope, keys, remote, recipientSha256, now,
    readBundle: () => op.operation === "recover-ledger" ? JSON.parse(readOwnerPrivateFile(c.mirrorFile, 4 * 1024 * 1024))
      : readOwnerErasureBundle({ directory: c.ledgerDirectory, scope: c.scope, keys, forbiddenRoots }) });
  let db: Database.Database | undefined; let fence: ErasureRuntimeFence | undefined; let ledger: ErasureLedgerStore | undefined;
  let writer: ReturnType<typeof createErasureS3Custody> | undefined;
  try {
    if (op.operation === "read") { const proof = await readCurrent();
      return { operation: op.operation, scope: c.scope, state: "REMOTE_VERIFIED", sequence: proof.bundle.entries.length }; }
    // Actual existing merchant DB, never an automatic empty/migrated substitute.
    db = new Database(c.databasePath, { fileMustExist: true, readonly: ["initialize-fence", "initialize-custody", "resume-initialization", "recover-ledger", "publish-pending"].includes(op.operation) });
    db.pragma("foreign_keys=ON"); if (classifyV2Database(db) !== "SUPPORTED") refuse("ERASURE_RESTORE_SCHEMA_REFUSED");
    if (op.operation === "initialize-fence" && existsSync(join(c.fenceDirectory, "erasure-fence.sqlite"))) refuse("ERASURE_OWNER_ALREADY_INITIALIZED");
    fence = new ErasureRuntimeFence({ directory: c.fenceDirectory, forbiddenRoots: [dirname(c.databasePath), c.ledgerDirectory, dirname(c.mirrorFile)],
      scope: c.scope, keys, readCurrent, now, initialize: op.operation === "initialize-fence" });
    if (op.operation === "initialize-fence") return { operation: op.operation, scope: c.scope, ...fence.status() };
    const merchant = db; const gate = fence;
    const publish = async (proof: VerifiedErasureLedger, drain: DrainedErasureRuntime) => {
      publishErasureReadMirror(c.mirrorFile, proof, drain, merchant, now());
    };
    if (op.operation === "reconcile") {
      await gate.withDrained(merchant, async drain => { const proof = await readCurrent(); await publish(proof, drain);
        const applied = applyDrainedRuntimeErasure(merchant, proof, keys, c.scope, drain, now());
        await gate.reopen(drain, proof, applied.application); });
      gate.openQualified(); return { operation: op.operation, scope: c.scope, state: "ERASURE_APPLIED", processorDeletion: "PENDING", archiveDisposition: "PENDING" };
    }
    const privateKey = createPrivateKey(readOwnerPrivateFile(c.signer.privateKeyFile));
    if (op.operation === "recover-ledger") {
      if (existsSync(join(c.ledgerDirectory, "erasure-ledger.sqlite"))) refuse("ERASURE_OWNER_ALREADY_INITIALIZED");
      await gate.withDrained(merchant, async () => {
        const proof = await readCurrent(); // Fresh remote history/packet before ANY journal creation.
        ledger = new ErasureLedgerStore({directory: c.ledgerDirectory, scope: c.scope, keys, signer: {keyId: c.signer.keyId, privateKey}, forbiddenRoots});
        ledger.restoreVerified(proof, now());
      });
      return {operation: op.operation, scope: c.scope, state: "CLOSED", remote: "CONFIRMED", runtimeAdmission: "PENDING"};
    }
    writer = createErasureS3Custody({ ...c.remote, scope: c.scope, prefix: `flexperiment/erasure/${c.scope}/`,
      accessKeyId: readOwnerPrivateFile(c.remote.writeAccessKeyFile).trim(), secretAccessKey: readOwnerPrivateFile(c.remote.writeSecretKeyFile).trim(), requestHandler: options?.requestHandler });
    if (op.operation === "initialize-custody") {
      if (existsSync(join(c.ledgerDirectory, "erasure-ledger.sqlite")) || existsSync(c.mirrorFile) || await writer.read("head.json")) refuse("ERASURE_OWNER_ALREADY_INITIALIZED");
    } else if (!existsSync(join(c.ledgerDirectory, "erasure-ledger.sqlite"))) refuse("ERASURE_REMOTE_UNINITIALIZED");
    ledger = new ErasureLedgerStore({ directory: c.ledgerDirectory, scope: c.scope, keys, signer: { keyId: c.signer.keyId, privateKey }, forbiddenRoots });
    const owner = new ErasureCustodian({ store: ledger, remote: writer, scope: c.scope, keys, signer: { keyId: c.signer.keyId, privateKey }, recipient: c.recipient });
    if (op.operation === "initialize-custody" || op.operation === "resume-initialization" || op.operation === "publish-pending") {
      await gate.withDrained(merchant, async drain => {
        if (op.operation === "resume-initialization") {
          // Explicit recovery of the SAME empty local journal after a lost ACK.
          // A committed head is reconciled read-only; a partial packet is reused.
          if (ledger!.export().entries.length || existsSync(c.mirrorFile)) refuse("ERASURE_REMOTE_INITIALIZATION_REFUSED");
          if (!await writer!.read("head.json")) await owner.initializeEmptyCustody(now());
        } else if (op.operation === "initialize-custody") await owner.initializeEmptyCustody(now()); else await owner.publishPending(now());
        const proof = await readCurrent(); await publish(proof, drain);
      });
      return { operation: op.operation, scope: c.scope, state: "CLOSED", remote: "CONFIRMED", runtimeAdmission: "PENDING" };
    }
    if (op.operation !== "admit") refuse();
    // LIVE owner attach applies current ledger without BOOT_RESTORE's blanket
    // session invalidation. Then derive the genuine request from Better Auth.
    await gate.withDrained(merchant, async drain => { const proof = await readCurrent();
      const applied = applyDrainedRuntimeErasure(merchant, proof, keys, c.scope, drain, now());
      await gate.reopen(drain, proof, applied.application); }); gate.openQualified();
    if (!c.authEnvironmentFile) refuse();
    const authEnvironment = z.record(z.string(), z.string()).parse(JSON.parse(readOwnerPrivateFile(c.authEnvironmentFile)));
    z.object({NODE_ENV: z.literal("production"), DEPLOY_ENV: z.literal("staging"),
      BETTER_AUTH_SECRET: z.string().min(32), AUTH_EMAIL_OUTBOX_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
      PLATFORM_ORIGIN: z.literal(allowedOrigins[0]), LAB_ORIGIN: z.literal(allowedOrigins[1]),
      ADMIN_ORIGIN: z.literal(allowedOrigins[2]), API_ORIGIN: z.literal(allowedOrigins[3]),
    }).passthrough().parse(authEnvironment);
    const auth = createAuthRuntime({ db: merchant, erasureFence: gate, environment: authEnvironment,
      sendMagicLinkEmail: async () => refuse("ERASURE_OWNER_EMAIL_DISABLED") });
    const headers = new Headers(op.headers);
    const request = await gate.run("REQUEST", () => VerifiedErasureRequest.fromSession({ db: merchant, headers,
      body: { requestId: op.requestId }, scope: c.scope, keys, subjectKeyId: c.subjectKeyId,
      allowedOrigins, getSession: h => auth.auth.api.getSession({ headers: h }), now }));
    return await admitVerifiedErasure({ db: merchant, request, fence: gate, custodian: owner, keys, now, publishReadMirror: publish });
  } catch (error) {
    fence?.closeAdmission();
    if (error instanceof ErasureLedgerError) throw error;
    return refuse("ERASURE_OWNER_OPERATION_REFUSED");
  } finally { ledger?.close(); writer?.close(); fence?.close(); db?.close(); remote.close(); }
}
