import Database from "better-sqlite3";
import { createHash, createHmac, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const instant = z.string().datetime();
const scope = z.enum(["canary", "production"]);
const reference = z.object({ keyId, keySha256: digest, email: digest, customer: digest, user: digest }).strict();
const bodySchema = z.object({
  version: z.literal(1), scope, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(), kind: z.enum(["ERASURE", "MARKETING_SUPPRESSION"]),
  subject: reference, recordedAt: instant, previousHash: digest, signingKeyId: keyId,
}).strict();
const entrySchema = z.object({ body: bodySchema, hash: digest, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const bundleSchema = z.object({ version: z.literal(1), scope, entries: z.array(entrySchema).max(100_000) }).strict();
const checkpointBodySchema = z.object({
  version: z.literal(1), scope, sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  headHash: digest, nonce: digest, issuedAt: instant, signingKeyId: keyId,
}).strict();
const checkpointSchema = z.object({ body: checkpointBodySchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
type Scope = z.infer<typeof scope>;
export type ErasureSubject = z.infer<typeof reference>;
export type ErasureEntry = z.infer<typeof entrySchema>;
export type ErasureBundle = z.infer<typeof bundleSchema>;
export type ErasureCheckpoint = z.infer<typeof checkpointSchema>;
export type ErasureKeys = {
  readonly signing: Readonly<Record<string, KeyObject>>;
  readonly subject: Readonly<Record<string, Buffer>>;
};
export type ErasureSigner = { readonly keyId: string; readonly privateKey: KeyObject };

// No raw identifiers, provider bodies, key material or underlying exceptions in errors.
export class ErasureLedgerError extends Error {
  constructor(code: string) { super(code); this.name = "ErasureLedgerError"; }
}
const refuse = (code: string): never => { throw new ErasureLedgerError(code); };
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const genesis = (environment: Scope) => hash({ version: 1, scope: environment, type: "flexperiment-erasure-genesis" });
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  return result.success ? result.data : refuse("ERASURE_LEDGER_INVALID");
};
function signingKey(keys: ErasureKeys, id: string) {
  const key = keys.signing[id];
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519") refuse("ERASURE_SIGNING_KEY_MISSING");
  return key;
}
function assertSigner(signer: ErasureSigner, keys: ErasureKeys) {
  parse(keyId, signer.keyId);
  if (signer.privateKey.type !== "private" || signer.privateKey.asymmetricKeyType !== "ed25519"
    || !createPublicKey(signer.privateKey).equals(signingKey(keys, signer.keyId))) refuse("ERASURE_SIGNER_INVALID");
}
function signature(value: unknown, signer: ErasureSigner) {
  return sign(null, Buffer.from(canonical(value)), signer.privateKey).toString("base64url");
}
function validSignature(value: unknown, presented: string, key: KeyObject) {
  const bytes = Buffer.from(presented, "base64url");
  return bytes.toString("base64url") === presented && verify(null, Buffer.from(canonical(value)), key, bytes);
}

/** Pseudonyms remain personal data. Keep every referenced subject-key generation in escrow. */
export function erasureSubject(keys: ErasureKeys, id: string, environment: Scope, input: {
  email: string; customerId: string; userId: string;
}): ErasureSubject {
  parse(keyId, id); parse(scope, environment);
  const key = keys.subject[id];
  if (!key || key.length !== 32) refuse("ERASURE_SUBJECT_KEY_MISSING");
  const email = input.email.trim().toLocaleLowerCase("en-US");
  if (!email || email.length > 254 || !input.customerId || !input.userId
    || input.customerId.length > 256 || input.userId.length > 256) refuse("ERASURE_SUBJECT_INVALID");
  return { keyId: id, keySha256: createHash("sha256").update(key).digest("hex"), email: erasurePseudonym(keys, id, environment, "email", email),
    customer: erasurePseudonym(keys, id, environment, "customer", input.customerId),
    user: erasurePseudonym(keys, id, environment, "user", input.userId) };
}

export function erasurePseudonym(keys: ErasureKeys, id: string, environment: Scope,
  category: "email" | "customer" | "user", value: string) {
  const key = keys.subject[id];
  if (!key || key.length !== 32) refuse("ERASURE_SUBJECT_KEY_MISSING");
  return createHmac("sha256", key).update(canonical(["flexperiment-erasure-v1", environment, category,
    category === "email" ? value.trim().toLocaleLowerCase("en-US") : value])).digest("hex");
}

function validateBundle(value: unknown, expectedScope: Scope, keys: ErasureKeys): ErasureBundle {
  const bundle = parse(bundleSchema, value);
  if (bundle.scope !== expectedScope) refuse("ERASURE_SCOPE_MISMATCH");
  let previous = genesis(expectedScope);
  let lastTime = "";
  const requests = new Set<string>();
  for (const [index, entry] of bundle.entries.entries()) {
    const body = entry.body;
    if (body.scope !== expectedScope || body.sequence !== index + 1 || body.previousHash !== previous
      || (lastTime && Date.parse(body.recordedAt) < Date.parse(lastTime)) || requests.has(body.requestId) || entry.hash !== hash(body)
      || !validSignature(body, entry.signature, signingKey(keys, body.signingKeyId))) refuse("ERASURE_CHAIN_INVALID");
    assertErasureSubjectKey(keys, body.subject);
    previous = entry.hash; lastTime = body.recordedAt; requests.add(body.requestId);
  }
  return bundle;
}

export function assertErasureSubjectKey(keys: ErasureKeys, subject: ErasureSubject) {
  const key = keys.subject[subject.keyId];
  if (key?.length !== 32 || createHash("sha256").update(key).digest("hex") !== subject.keySha256) {
    refuse("ERASURE_SUBJECT_KEY_MISSING");
  }
}

/** Issued by the independently current authority, NOT by a restored merchant snapshot.
 * Issuance alone does not prove remote custody. Host/API installation is a separate gate. */
export function issueErasureCheckpoint(bundle: ErasureBundle, nonce: string, signer: ErasureSigner, keys: ErasureKeys,
  now = new Date()): ErasureCheckpoint {
  const complete = validateBundle(bundle, bundle.scope, keys); assertSigner(signer, keys);
  if (complete.entries.at(-1) && Date.parse(complete.entries.at(-1)!.body.recordedAt) > now.getTime()) refuse("ERASURE_CLOCK_REGRESSION");
  const body = parse(checkpointBodySchema, { version: 1, scope: complete.scope, sequence: complete.entries.length,
    headHash: complete.entries.at(-1)?.hash ?? genesis(complete.scope), nonce, issuedAt: now.toISOString(), signingKeyId: signer.keyId });
  return { body, signature: signature(body, signer) };
}

// Only this module can create a verified capability. Callers cannot skip verification
// by structurally constructing a bundle, or reuse a stale capability indefinitely.
const verifiedCapabilities = new WeakSet<VerifiedErasureLedger>();
const verificationAuthority = Object.freeze({});
export class VerifiedErasureLedger {
  private constructor(readonly bundle: ErasureBundle, readonly verifiedAt: number, authority: object) {
    if (authority !== verificationAuthority) refuse("ERASURE_ADMISSION_INVALID");
    verifiedCapabilities.add(this); Object.freeze(this);
  }
  static async read(input: {
    scope: Scope; bundle: unknown; keys: ErasureKeys;
    /** Must make an authenticated uncached read from independent live checkpoint authority.
     * No fallback to a saved checkpoint, merchant DB or backup metadata is allowed. */
    readCurrentCheckpoint: (nonce: string) => Promise<unknown>;
    now?: () => Date;
  }) {
    const now = input.now ?? (() => new Date());
    const nonce = randomBytes(32).toString("hex");
    let value: unknown;
    try { value = await input.readCurrentCheckpoint(nonce); }
    catch { return refuse("ERASURE_CHECKPOINT_UNAVAILABLE"); }
    const checkpoint = parse(checkpointSchema, value);
    const body = checkpoint.body;
    const checkedAt = now().getTime();
    const age = checkedAt - Date.parse(body.issuedAt);
    if (body.scope !== input.scope || body.nonce !== nonce || age < 0 || age > 60_000
      || !validSignature(body, checkpoint.signature, signingKey(input.keys, body.signingKeyId))) refuse("ERASURE_CHECKPOINT_INVALID");
    const bundle = validateBundle(input.bundle, input.scope, input.keys);
    if (bundle.entries.at(-1) && Date.parse(bundle.entries.at(-1)!.body.recordedAt) > Date.parse(body.issuedAt)) refuse("ERASURE_CHECKPOINT_INVALID");
    if (body.sequence !== bundle.entries.length || body.headHash !== (bundle.entries.at(-1)?.hash ?? genesis(input.scope))) {
      refuse("ERASURE_LEDGER_STALE_OR_INCOMPLETE");
    }
    // The verified object must not alias mutable input supplied by an operator/API.
    for (const entry of bundle.entries) { Object.freeze(entry.body.subject); Object.freeze(entry.body); Object.freeze(entry); }
    Object.freeze(bundle.entries); Object.freeze(bundle);
    return new VerifiedErasureLedger(bundle, checkedAt, verificationAuthority);
  }
  assertFresh(now = new Date()) {
    if (!verifiedCapabilities.has(this)) refuse("ERASURE_ADMISSION_INVALID");
    const age = now.getTime() - this.verifiedAt;
    if (age < 0 || age > 60_000) refuse("ERASURE_ADMISSION_EXPIRED");
  }
}

/** Owner-side store. Never embedded in merchant/editorial SQLite or their archives.
 * SQLite FULL synchronous + DELETE journal is the durable local append boundary.
 * Independent remote checkpoint/custody acknowledgement must precede live erasure;
 * this first core does not install a host adapter or expose a deletion endpoint. */
export class ErasureLedgerStore {
  readonly #db!: Database.Database;
  readonly #options: { directory: string; scope: Scope; forbiddenRoots: readonly string[]; keys: ErasureKeys; signer: ErasureSigner };
  constructor(options: { directory: string; scope: Scope; forbiddenRoots: readonly string[]; keys: ErasureKeys; signer: ErasureSigner }) {
    this.#options = options;
    try {
    parse(scope, options.scope); assertSigner(options.signer, options.keys);
    const directory = options.directory;
    if (!isAbsolute(directory) || !existsSync(directory) || lstatSync(directory).isSymbolicLink()
      || !statSync(directory).isDirectory() || (statSync(directory).mode & 0o777) !== 0o700
      || statSync(directory).uid !== process.getuid?.() || !options.forbiddenRoots.length) refuse("ERASURE_STORAGE_INVALID");
    const resolved = realpathSync(directory);
    for (const root of options.forbiddenRoots) {
      if (!isAbsolute(root) || !existsSync(root)) refuse("ERASURE_STORAGE_INVALID");
      const difference = relative(realpathSync(root), resolved);
      if (!difference || (!difference.startsWith("../") && difference !== ".." && !isAbsolute(difference))) refuse("ERASURE_STORAGE_NOT_INDEPENDENT");
    }
    const filename = join(directory, "erasure-ledger.sqlite");
    if (!existsSync(filename)) {
      const file = openSync(filename, "wx", 0o600); closeSync(file);
      const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    if (lstatSync(filename).isSymbolicLink() || !statSync(filename).isFile() || statSync(filename).nlink !== 1
      || statSync(filename).uid !== process.getuid?.() || (statSync(filename).mode & 0o777) !== 0o600) refuse("ERASURE_STORAGE_INVALID");
    this.#db = new Database(filename);
    try {
      this.#db.pragma("journal_mode=DELETE"); this.#db.pragma("synchronous=FULL"); this.#db.pragma("busy_timeout=5000");
      const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      if (tables.some(table => !["erasure_identity", "erasure_entries"].includes(table.name))) refuse("ERASURE_STORAGE_NOT_INDEPENDENT");
      this.#db.exec(`CREATE TABLE IF NOT EXISTS erasure_identity(scope TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS erasure_entries(sequence INTEGER PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,entry_json TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS erasure_entry_update BEFORE UPDATE ON erasure_entries BEGIN SELECT RAISE(ABORT,'ERASURE_HISTORY_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS erasure_entry_delete BEFORE DELETE ON erasure_entries BEGIN SELECT RAISE(ABORT,'ERASURE_HISTORY_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS erasure_identity_update BEFORE UPDATE ON erasure_identity BEGIN SELECT RAISE(ABORT,'ERASURE_HISTORY_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS erasure_identity_delete BEFORE DELETE ON erasure_identity BEGIN SELECT RAISE(ABORT,'ERASURE_HISTORY_IMMUTABLE'); END;`);
      const identities = this.#db.prepare("SELECT scope FROM erasure_identity").all() as Array<{ scope: string }>;
      if (!identities.length) {
        if (this.#db.prepare("SELECT 1 FROM erasure_entries LIMIT 1").get()) refuse("ERASURE_STORAGE_INVALID");
        this.#db.prepare("INSERT INTO erasure_identity(scope) VALUES (?)").run(options.scope);
      } else if (identities.length !== 1 || identities[0].scope !== options.scope) refuse("ERASURE_SCOPE_MISMATCH");
      this.export();
    } catch { this.#db.close(); refuse("ERASURE_STORAGE_INVALID"); }
    } catch (error) {
      if (error instanceof ErasureLedgerError) throw error;
      refuse("ERASURE_STORAGE_INVALID");
    }
  }
  export(): ErasureBundle {
    try {
      const rows = this.#db.prepare("SELECT sequence,request_id,entry_json FROM erasure_entries ORDER BY sequence").all() as
        Array<{ sequence: number; request_id: string; entry_json: string }>;
      if (rows.length > 100_000) refuse("ERASURE_LEDGER_CAPACITY_REVIEW_REQUIRED");
      const entries = rows.map(row => {
        if (row.entry_json.length > 4096) refuse("ERASURE_LEDGER_INVALID");
        const entry = parse(entrySchema, JSON.parse(row.entry_json));
        if (entry.body.sequence !== row.sequence || entry.body.requestId !== row.request_id) refuse("ERASURE_CHAIN_INVALID");
        return entry;
      });
      return validateBundle({ version: 1, scope: this.#options.scope, entries }, this.#options.scope, this.#options.keys);
    } catch { return refuse("ERASURE_LEDGER_INVALID"); }
  }
  append(input: { requestId: string; kind: "ERASURE" | "MARKETING_SUPPRESSION"; subject: ErasureSubject }, now = new Date()) {
    try { return this.#db.transaction(() => {
      const bundle = this.export();
      const existing = bundle.entries.find(entry => entry.body.requestId === input.requestId);
      if (existing) {
        if (existing.body.kind !== input.kind || canonical(existing.body.subject) !== canonical(input.subject)) refuse("ERASURE_REQUEST_CONFLICT");
        return existing;
      }
      if (bundle.entries.length >= 100_000) refuse("ERASURE_LEDGER_CAPACITY_REVIEW_REQUIRED");
      const previous = bundle.entries.at(-1);
      if (previous && now.getTime() < Date.parse(previous.body.recordedAt)) refuse("ERASURE_CLOCK_REGRESSION");
      const body = parse(bodySchema, { version: 1, scope: this.#options.scope, sequence: bundle.entries.length + 1,
        ...input, recordedAt: now.toISOString(), previousHash: previous?.hash ?? genesis(this.#options.scope), signingKeyId: this.#options.signer.keyId });
      assertErasureSubjectKey(this.#options.keys, body.subject);
      const entry = { body, hash: hash(body), signature: signature(body, this.#options.signer) };
      this.#db.prepare("INSERT INTO erasure_entries(sequence,request_id,entry_json) VALUES (?,?,?)")
        .run(body.sequence, body.requestId, canonical(entry));
      return entry;
    }).immediate(); } catch (error) {
      if (error instanceof ErasureLedgerError) throw error;
      return refuse("ERASURE_APPEND_REFUSED");
    }
  }
  close() { this.#db.close(); }
}
