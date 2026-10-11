import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ErasureLedgerError, ErasureLedgerStore, issueErasureCheckpoint, VerifiedErasureLedger,
  type ErasureBundle, type ErasureCheckpoint, type ErasureKeys, type ErasureSigner } from "./erasure-ledger";
import { VerifiedErasureRequest } from "./erasure-request";

export const CUSTODY_MAX_BYTES = 8 * 1024 * 1024;
export type CustodyObject = { readonly bytes: Buffer; readonly etag: string };
/** Independent uncached store. Conditional writes MUST be atomic; no retry/delete/list fallback.
 * Installation separately qualifies off-VPS authority, no-delete IAM, CAS semantics and key escrow. */
export interface ErasureCustodyObjects {
  read(key: string): Promise<CustodyObject | null>;
  create(key: string, bytes: Buffer): Promise<void>;
  compareExchange(key: string, bytes: Buffer, etag: string): Promise<void>;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const environment = z.enum(["canary", "production"]);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const headerSchema = z.object({ version: z.literal(1), scope: environment,
  sequence: z.number().int().nonnegative().max(100_000), headHash: digest,
  plaintextSha256: digest, ciphertextSha256: digest, recipientSha256: digest, signingKeyId: keyId }).strict();
const packetSchema = z.object({ header: headerSchema, signature,
  ciphertext: z.string().min(1).max(CUSTODY_MAX_BYTES).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const headBodySchema = z.object({ version: z.literal(1), scope: environment,
  sequence: z.number().int().nonnegative().max(100_000), headHash: digest,
  packetSha256: digest, objectRef: z.string().regex(/^bundles\/[0-9]+-[a-f0-9]{64}\.json$/),
  recipientSha256: digest, signingKeyId: keyId }).strict();
const headSchema = z.object({ body: headBodySchema, signature }).strict();
export type SignedCustodyHead = z.infer<typeof headSchema>;
export type RemoteErasureAck = { bundle: ErasureBundle; checkpoint: ErasureCheckpoint; custodyHead: SignedCustodyHead };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function refuse(code: string): never { throw new ErasureLedgerError(code); }
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value); return parsed.success ? parsed.data : refuse("ERASURE_CUSTODY_INVALID");
};
const json = (bytes: Buffer): unknown => {
  if (!bytes.length || bytes.length > CUSTODY_MAX_BYTES) refuse("ERASURE_CUSTODY_INVALID");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return refuse("ERASURE_CUSTODY_INVALID"); }
};
const seal = (value: unknown, signer: ErasureSigner) => sign(null, Buffer.from(canonical(value)), signer.privateKey).toString("base64url");
function checkSignature(value: unknown, presented: string, id: string, keys: ErasureKeys) {
  const key = keys.signing[id]; const bytes = Buffer.from(presented, "base64url");
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519" || bytes.toString("base64url") !== presented
    || !verify(null, Buffer.from(canonical(value)), key, bytes)) refuse("ERASURE_CUSTODY_INVALID");
}
export function validateCustodyHead(value: unknown, scope: "canary" | "production", keys: ErasureKeys) {
  const head = parse(headSchema, value);
  if (head.body.scope !== scope || head.body.objectRef !== `bundles/${head.body.sequence}-${head.body.headHash}.json`) refuse("ERASURE_CUSTODY_INVALID");
  checkSignature(head.body, head.signature, head.body.signingKeyId, keys); return head;
}

/** Public recipient only; no recovery identity, plaintext file, shell or raw subprocess output. */
export function ageCustodyEncryption(recipient: string) {
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) refuse("ERASURE_CUSTODY_RECIPIENT_INVALID");
  return { recipientSha256: sha(recipient), encrypt: (plaintext: Buffer) => {
    if (plaintext.length > 4 * 1024 * 1024) refuse("ERASURE_CUSTODY_CAPACITY_REVIEW_REQUIRED");
    const result = spawnSync("age", ["--encrypt", "--recipient", recipient], { input: plaintext,
      maxBuffer: CUSTODY_MAX_BYTES, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    if (result.status !== 0 || !result.stdout.length || result.stdout.length > 6 * 1024 * 1024) refuse("ERASURE_CUSTODY_ENCRYPTION_FAILED");
    return result.stdout;
  } };
}

/** Owner-side only, NOT an application startup dependency. Signing key/S3 privilege never
 * belongs in Commerce. Stage 2 must close/drain all runtime writers before calling submit.
 * Local append alone is PENDING, not admitted; no erase/provider operation occurs here. */
export class ErasureCustodian {
  readonly #keys: ErasureKeys;
  readonly #signer: ErasureSigner;
  readonly #store: ErasureLedgerStore;
  readonly #remote: ErasureCustodyObjects;
  readonly #scope: "canary" | "production";
  readonly #encryption: ReturnType<typeof ageCustodyEncryption>;
  constructor(input: { store: ErasureLedgerStore; remote: ErasureCustodyObjects; scope: "canary" | "production";
    keys: ErasureKeys; signer: ErasureSigner; recipient: string }) {
    this.#keys = { signing: { ...input.keys.signing }, subject: Object.fromEntries(Object.entries(input.keys.subject).map(([id, key]) => [id, Buffer.from(key)])) };
    this.#signer = { ...input.signer }; this.#store = input.store;
    const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); } catch { return refuse("ERASURE_REMOTE_OPERATION_UNCONFIRMED"); }
    };
    this.#remote = {
      read: key => safe(() => input.remote.read(key)),
      create: (key, bytes) => safe(() => input.remote.create(key, bytes)),
      compareExchange: (key, bytes, etag) => safe(() => input.remote.compareExchange(key, bytes, etag)),
    };
    this.#scope = parse(environment, input.scope); this.#encryption = ageCustodyEncryption(input.recipient);
    const publicKey = this.#keys.signing[this.#signer.keyId];
    if (!publicKey || this.#signer.privateKey.type !== "private" || this.#signer.privateKey.asymmetricKeyType !== "ed25519"
      || !createPublicKey(this.#signer.privateKey).equals(publicKey)) refuse("ERASURE_SIGNER_INVALID");
  }
  #bundle() {
    const bundle = this.#store.export(); if (bundle.scope !== this.#scope) refuse("ERASURE_SCOPE_MISMATCH"); return bundle;
  }
  #localHead(bundle: ErasureBundle, now: Date) {
    return issueErasureCheckpoint(bundle, "0".repeat(64), this.#signer, this.#keys, now).body.headHash;
  }
  async #readHead() {
    const object = await this.#remote.read("head.json");
    if (!object || !object.etag) return refuse("ERASURE_REMOTE_UNINITIALIZED");
    const head = validateCustodyHead(json(object.bytes), this.#scope, this.#keys);
    if (head.body.recipientSha256 !== this.#encryption.recipientSha256) refuse("ERASURE_CUSTODY_RECIPIENT_INVALID");
    return { head, etag: object.etag };
  }
  async #packet(bundle: ErasureBundle, now: Date) {
    const plaintext = Buffer.from(canonical(bundle)); const headHash = this.#localHead(bundle, now);
    const key = `bundles/${bundle.entries.length}-${headHash}.json`;
    let existing = await this.#remote.read(key);
    if (!existing) {
      const encrypted = this.#encryption.encrypt(plaintext);
      const header = { version: 1 as const, scope: this.#scope, sequence: bundle.entries.length, headHash,
        plaintextSha256: sha(plaintext), ciphertextSha256: sha(encrypted), recipientSha256: this.#encryption.recipientSha256,
        signingKeyId: this.#signer.keyId };
      const bytes = Buffer.from(canonical({ header, signature: seal(header, this.#signer), ciphertext: encrypted.toString("base64") }));
      if (bytes.length > CUSTODY_MAX_BYTES) refuse("ERASURE_CUSTODY_CAPACITY_REVIEW_REQUIRED");
      await this.#remote.create(key, bytes); // A timeout/412 stops; caller reconciles GET-only.
      existing = await this.#remote.read(key);
      if (!existing || !existing.bytes.equals(bytes)) refuse("ERASURE_REMOTE_READBACK_FAILED");
    }
    const packet = parse(packetSchema, json(existing.bytes));
    checkSignature(packet.header, packet.signature, packet.header.signingKeyId, this.#keys);
    const encrypted = Buffer.from(packet.ciphertext, "base64");
    if (encrypted.toString("base64") !== packet.ciphertext || packet.header.scope !== this.#scope
      || packet.header.sequence !== bundle.entries.length || packet.header.headHash !== headHash
      || packet.header.plaintextSha256 !== sha(plaintext) || packet.header.ciphertextSha256 !== sha(encrypted)
      || packet.header.recipientSha256 !== this.#encryption.recipientSha256) refuse("ERASURE_CUSTODY_INVALID");
    const body = { version: 1 as const, scope: this.#scope, sequence: bundle.entries.length, headHash,
      packetSha256: sha(existing.bytes), objectRef: key, recipientSha256: this.#encryption.recipientSha256, signingKeyId: this.#signer.keyId };
    return { body, signature: seal(body, this.#signer) };
  }
  /** Explicit installation operation, empty local ledger only. Never called from read/submit. */
  async initializeEmptyCustody(now = new Date()) {
    const bundle = this.#bundle(); if (bundle.entries.length) refuse("ERASURE_REMOTE_INITIALIZATION_REFUSED");
    if (await this.#remote.read("head.json")) refuse("ERASURE_REMOTE_INITIALIZATION_REFUSED");
    const head = await this.#packet(bundle, now);
    await this.#remote.create("head.json", Buffer.from(canonical(head)));
    const current = await this.#readHead();
    if (canonical(current.head) !== canonical(head)) refuse("ERASURE_REMOTE_READBACK_FAILED");
  }
  /** Explicit repair of a pending local append; GET-first, same complete ledger, no new request. */
  async publishPending(now = new Date()) {
    const bundle = this.#bundle(); const current = await this.#readHead();
    const n = current.head.body.sequence;
    const genesis = this.#localHead({ version: 1, scope: this.#scope, entries: [] }, now);
    if (n > bundle.entries.length || current.head.body.headHash !== (n ? bundle.entries[n - 1]?.hash : genesis)) {
      refuse("ERASURE_LOCAL_LEDGER_STALE_OR_FORKED");
    }
    if (n === bundle.entries.length) return; // Lost ACK: do not overwrite or re-encrypt.
    const head = await this.#packet(bundle, now);
    await this.#remote.compareExchange("head.json", Buffer.from(canonical(head)), current.etag);
    const readBack = await this.#readHead();
    if (canonical(readBack.head) !== canonical(head)) refuse("ERASURE_REMOTE_ACK_UNCONFIRMED");
  }
  async submit(db: Database.Database, request: VerifiedErasureRequest, now = new Date()) {
    VerifiedErasureRequest.assertCurrent(request, db, now);
    if (request.scope !== this.#scope) refuse("ERASURE_SCOPE_MISMATCH");
    const before = this.#bundle(); const existing = before.entries.find(entry => entry.body.requestId === request.requestId);
    this.#store.append({ requestId: request.requestId, kind: "ERASURE", subject: request.subject }, now);
    // An existing request is never blindly republished after an uncertain result.
    if (!existing) await this.publishPending(now);
    return { requestId: request.requestId, state: "REMOTE_RECONCILIATION_REQUIRED" as const };
  }
  /** Nonmutating. Current remote head AND exact ciphertext read-back precede nonce ACK. */
  async reconcile(requestId: string | null, nonce: string, now = new Date()): Promise<RemoteErasureAck> {
    if (requestId !== null && !z.string().uuid().safeParse(requestId).success) refuse("ERASURE_REQUEST_INVALID");
    const { head } = await this.#readHead(); const object = await this.#remote.read(head.body.objectRef);
    if (!object || sha(object.bytes) !== head.body.packetSha256) refuse("ERASURE_REMOTE_READBACK_FAILED");
    const bundle = this.#bundle();
    if (head.body.sequence !== bundle.entries.length || head.body.headHash !== this.#localHead(bundle, now)) refuse("ERASURE_LOCAL_LEDGER_STALE_OR_FORKED");
    const packet = parse(packetSchema, json(object.bytes));
    checkSignature(packet.header, packet.signature, packet.header.signingKeyId, this.#keys);
    if (packet.header.plaintextSha256 !== sha(canonical(bundle)) || packet.header.scope !== this.#scope
      || packet.header.headHash !== head.body.headHash || packet.header.sequence !== head.body.sequence
      || packet.header.recipientSha256 !== head.body.recipientSha256
      || Buffer.from(packet.ciphertext, "base64").toString("base64") !== packet.ciphertext
      || sha(Buffer.from(packet.ciphertext, "base64")) !== packet.header.ciphertextSha256) refuse("ERASURE_CUSTODY_INVALID");
    if (requestId && !bundle.entries.some(entry => entry.body.requestId === requestId)) refuse("ERASURE_REQUEST_NOT_REMOTE_CONFIRMED");
    // A concurrent publisher cannot make an older object look current.
    if (canonical((await this.#readHead()).head) !== canonical(head)) refuse("ERASURE_REMOTE_ACK_UNCONFIRMED");
    return { bundle, checkpoint: issueErasureCheckpoint(bundle, nonce, this.#signer, this.#keys, now), custodyHead: head };
  }
}

/** Runtime has only verification keys and a scoped authenticated read adapter, no signer/S3 keys. */
export async function readRemoteErasureLedger(input: { scope: "canary" | "production"; keys: ErasureKeys;
  read: (nonce: string) => Promise<RemoteErasureAck>; now?: () => Date }) {
  let ack: RemoteErasureAck | undefined;
  // Obtain bundle and signed nonce in one uncached read; VerifiedErasureLedger creates the nonce.
  const proof = await VerifiedErasureLedger.read({ scope: input.scope, keys: input.keys,
    get bundle() { return ack?.bundle; }, now: input.now,
    readCurrentCheckpoint: async nonce => {
      ack = await input.read(nonce);
      const head = validateCustodyHead(ack.custodyHead, input.scope, input.keys);
      if (head.body.sequence !== ack.checkpoint.body.sequence || head.body.headHash !== ack.checkpoint.body.headHash) refuse("ERASURE_REMOTE_ACK_UNCONFIRMED");
      return ack.checkpoint;
    } });
  return proof;
}

export async function confirmRemoteErasureRequest(request: VerifiedErasureRequest, input: Parameters<typeof readRemoteErasureLedger>[0]) {
  VerifiedErasureRequest.assertVerified(request);
  if (request.scope !== input.scope) refuse("ERASURE_SCOPE_MISMATCH");
  const proof = await readRemoteErasureLedger(input);
  const entry = proof.bundle.entries.find(candidate => candidate.body.requestId === request.requestId);
  if (!entry || entry.body.kind !== "ERASURE" || canonical(entry.body.subject) !== canonical(request.subject)) refuse("ERASURE_REQUEST_NOT_REMOTE_CONFIRMED");
  return { requestId: request.requestId, state: "REMOTE_DURABLE_CONFIRMED" as const, proof };
}
