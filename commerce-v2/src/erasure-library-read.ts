import { GetBucketVersioningCommand, GetObjectCommand, ListObjectVersionsCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { z } from "zod";
import { CUSTODY_MAX_BYTES, validateCustodyHead, verifyCustodyPacket, type CustodyObject } from "./erasure-custody";
import { ErasureLedgerError, VerifiedErasureLedger, erasureGenesisHash, type ErasureBundle, type ErasureKeys } from "./erasure-ledger";

function refuse(code = "ERASURE_LIBRARY_READ_UNAVAILABLE"): never { throw new ErasureLedgerError(code); }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(value);
const configSchema = z.object({ version: z.literal(1), scope: z.enum(["canary", "production"]),
  endpoint: z.literal("https://s3.cloud.ru"), region: z.literal("ru-central-1"),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    expectedBucketOwner: z.string().regex(/^[^\r\n]{1,128}$/),
  prefix: z.string(), bundleFile: z.string().max(1024).refine(isAbsolute),
  recipientSha256: z.string().regex(/^[a-f0-9]{64}$/),
  accessKeyId: z.string().min(1).max(256), secretAccessKey: z.string().min(1).max(256),
}).strict();
export type ErasureReadConfiguration = z.infer<typeof configSchema>;
export function erasureReaderBinding(c: Pick<ErasureReadConfiguration, "scope" | "endpoint" | "region" | "bucket" | "prefix" | "recipientSha256" | "expectedBucketOwner">) {
  return createHash("sha256").update(canonical({ version: 1, scope: c.scope, endpoint: c.endpoint, region: c.region,
    bucket: c.bucket, prefix: c.prefix, recipientSha256: c.recipientSha256, expectedBucketOwner: c.expectedBucketOwner })).digest("hex");
}
export interface ErasureCurrentObjects {
  read(name: string, versionId?: string): Promise<CustodyObject | null>;
  headVersions(): Promise<readonly string[]>;
}

/** Read-only provider identity: no Put/Delete/control-plane commands, implicit
 * credentials, retries or redirects. Version history is checked at cold boot to
 * detect an accidental older head even after loss of the local applied prefix.
 * Cloud.ru consistency/IAM/version retention remain operational admission gates. */
export function createErasureCurrentObjects(configuration: ErasureReadConfiguration, requestHandler?: S3ClientConfig["requestHandler"])
  : ErasureCurrentObjects & { close(): void } {
  const parsed = configSchema.safeParse(configuration);
  if (!parsed.success || parsed.data.prefix !== `flexperiment/erasure/${parsed.data.scope}/`) refuse("ERASURE_LIBRARY_CONFIGURATION_INVALID");
  const c = parsed.data;
  const client = new S3Client({ endpoint: c.endpoint, region: c.region, forcePathStyle: true,
    maxAttempts: 1, followRegionRedirects: false, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, requestHandler });
  return {
    async read(name, versionId) {
      if (name !== "head.json" && !/^bundles\/[0-9]+-[a-f0-9]{64}\.json$/.test(name)) refuse();
      if (versionId !== undefined && (name !== "head.json" || !versionId || versionId === "null" || versionId.length > 1024)) refuse();
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: c.prefix + name, VersionId: versionId, ExpectedBucketOwner: c.expectedBucketOwner }),
          { abortSignal: AbortSignal.timeout(10_000) });
        const body = response.Body;
        if (!(body instanceof Readable) || !response.ETag || !/^"[^"\r\n]{1,128}"$/.test(response.ETag)
          || response.ContentLength === undefined || response.ContentLength > CUSTODY_MAX_BYTES) {
          if (body instanceof Readable) body.destroy(); refuse();
        }
        const chunks: Buffer[] = []; let length = 0;
        const timer = setTimeout(() => body.destroy(new Error("ERASURE_READ_TIMEOUT")), 10_000);
        try { for await (const value of body) { const bytes = Buffer.from(value); length += bytes.length;
          if (length > CUSTODY_MAX_BYTES) refuse(); chunks.push(bytes); } }
        finally { clearTimeout(timer); body.destroy(); }
        if (!length || length !== response.ContentLength) refuse();
        return { bytes: Buffer.concat(chunks, length), etag: response.ETag };
      } catch (error) {
        if (error instanceof Error && error.name === "NoSuchKey"
          && (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        return refuse();
      }
    },
    async headVersions() {
      try {
        const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: c.bucket, ExpectedBucketOwner: c.expectedBucketOwner }), { abortSignal: AbortSignal.timeout(10_000) });
        if (versioning.Status !== "Enabled") refuse("ERASURE_HISTORY_NOT_QUALIFIED");
        const versions: string[] = []; const seen = new Set<string>();
        let keyMarker: string | undefined; let versionMarker: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await client.send(new ListObjectVersionsCommand({ Bucket: c.bucket, ExpectedBucketOwner: c.expectedBucketOwner, Prefix: c.prefix + "head.json", MaxKeys: 100,
            KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: AbortSignal.timeout(10_000) });
          if (typeof result.IsTruncated !== "boolean" || (result.Versions?.length ?? 0) + (result.DeleteMarkers?.length ?? 0) > 100) refuse();
          if (result.DeleteMarkers?.some(v => v.Key === c.prefix + "head.json")) refuse("ERASURE_HISTORY_RECONCILIATION_REQUIRED");
          for (const v of result.Versions ?? []) {
            if (v.Key !== c.prefix + "head.json") continue;
            if (!v.VersionId || v.VersionId === "null" || v.VersionId.length > 1024 || seen.has(v.VersionId)) refuse();
            seen.add(v.VersionId); versions.push(v.VersionId);
          }
          if (!result.IsTruncated) { if (!versions.length) refuse(); return versions; }
          if (!result.NextKeyMarker || !result.NextVersionIdMarker
            || result.NextKeyMarker === keyMarker && result.NextVersionIdMarker === versionMarker) refuse();
          keyMarker = result.NextKeyMarker; versionMarker = result.NextVersionIdMarker;
        }
        return refuse("ERASURE_HISTORY_CAPACITY_REVIEW_REQUIRED");
      } catch { return refuse("ERASURE_HISTORY_NOT_QUALIFIED"); }
    },
    close: () => client.destroy(),
  };
}

/** Mirror is existing signed ErasureBundle JSON, never a new ledger/authority.
 * A stale mirror, missing remote object or fork cannot mint an admission proof. */
export function createCurrentErasureRead(input: { scope: "canary" | "production"; keys: ErasureKeys;
  recipientSha256: string; remote: ErasureCurrentObjects; readBundle: () => unknown; now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  let established: { sequence: number; headHash: string } | undefined;
  let history: Promise<readonly ReturnType<typeof validateCustodyHead>[]> | undefined;
  const readHead = async (versionId?: string) => {
    const value = await input.remote.read("head.json", versionId); if (!value) refuse("ERASURE_REMOTE_UNINITIALIZED");
    const head = validateCustodyHead(JSON.parse(value.bytes.toString("utf8")), input.scope, input.keys);
    if (head.body.recipientSha256 !== input.recipientSha256) refuse("ERASURE_CUSTODY_RECIPIENT_INVALID");
    return head;
  };
  return () => VerifiedErasureLedger.readCurrent({ scope: input.scope, keys: input.keys, now, read: async () => {
    try {
      const head = await readHead();
      if (!history) history = (async () => {
        const ids = await input.remote.headVersions();
        if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) refuse();
        const heads: ReturnType<typeof validateCustodyHead>[] = [];
        for (let i = 0; i < ids.length; i += 8) heads.push(...await Promise.all(ids.slice(i, i + 8).map(id => readHead(id))));
        return heads;
      })();
      const previous = await history;
      const bundle = input.readBundle() as ErasureBundle;
      const hashAt = (n: number) => n === 0 ? erasureGenesisHash(input.scope) : bundle.entries[n - 1]?.hash;
      for (const old of [...previous.map(v => v.body), ...(established ? [established] : [])]) {
        if (old.sequence > head.body.sequence || hashAt(old.sequence) !== old.headHash) refuse("ERASURE_REMOTE_LEDGER_ROLLBACK_OR_FORK");
      }
      const packet = await input.remote.read(head.body.objectRef); if (!packet) refuse("ERASURE_REMOTE_READBACK_FAILED");
      verifyCustodyPacket(packet.bytes, head, bundle, input.keys);
      if (canonical((await readHead()).body) !== canonical(head.body)) refuse("ERASURE_REMOTE_ACK_UNCONFIRMED");
      established = { sequence: head.body.sequence, headHash: head.body.headHash };
      return { bundle, ...established };
    } catch { return refuse(); }
  } });
}

/** Actual runtime files must be independent, owner-scoped and kernel RO-mounted.
 * Unit tests exercise the pure adapter; they do not fake this installation check. */
export function readErasureReaderFile(file: string, forbiddenRoots: readonly string[]) {
  try {
    if (!isAbsolute(file) || !forbiddenRoots.length) refuse();
    const s = lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.()
      || (s.mode & 0o777) !== 0o600 || s.size < 1 || s.size > CUSTODY_MAX_BYTES) refuse();
    const resolved = realpathSync(file);
    for (const root of forbiddenRoots) { const rel = relative(realpathSync(root), resolved);
      if (!rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) refuse(); }
    const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map(line => line.split(" - ")[0].split(" "));
    const matching = mounts.filter(f => f[4]?.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8))) === dirname(file));
    if (matching.length !== 1 || !matching[0][5]?.split(",").includes("ro")) refuse();
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch { return refuse("ERASURE_LIBRARY_CONFIGURATION_INVALID"); }
}

export function prepareLibraryErasureRead(input: { file: string; scope: "canary" | "production"; keys: ErasureKeys;
  forbiddenRoots: readonly string[]; now?: () => Date }) {
  const parsed = configSchema.safeParse(readErasureReaderFile(input.file, input.forbiddenRoots));
  if (!parsed.success || parsed.data.scope !== input.scope) refuse("ERASURE_LIBRARY_CONFIGURATION_INVALID");
  const configuration = parsed.data; const remote = createErasureCurrentObjects(configuration);
  return { bindingSha256: erasureReaderBinding(configuration), read: createCurrentErasureRead({ ...input, recipientSha256: configuration.recipientSha256, remote,
    readBundle: () => readErasureReaderFile(configuration.bundleFile, input.forbiddenRoots) }), close: remote.close };
}
