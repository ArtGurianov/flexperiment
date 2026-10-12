import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { ErasureLedgerError } from "./erasure-ledger";
import { CUSTODY_MAX_BYTES, type ErasureCustodyObjects } from "./erasure-custody";

function refuse(): never { throw new ErasureLedgerError("ERASURE_REMOTE_OPERATION_UNCONFIRMED"); }
/** Owner-side adapter only. Endpoint/IAM/conditional-write compatibility require independent
 * operational admission. No default credential chain, redirects, retries, list or delete API. */
export function createErasureS3Custody(input: { endpoint: string; region: string; bucket: string;
  prefix: string; scope: "canary" | "production"; accessKeyId: string; secretAccessKey: string;
  expectedBucketOwner?: string;
  requestHandler?: S3ClientConfig["requestHandler"] }): ErasureCustodyObjects & { close(): void } {
  let url: URL;
  try { url = new URL(input.endpoint); } catch { return refuse(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !/^[a-z0-9-]{1,64}$/.test(input.region) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)
    || !["canary", "production"].includes(input.scope) || input.prefix !== `flexperiment/erasure/${input.scope}/`
    || !input.accessKeyId || !input.secretAccessKey
    || input.expectedBucketOwner !== undefined && !/^[^\r\n]{1,128}$/.test(input.expectedBucketOwner)) refuse();
  const client = new S3Client({ endpoint: url.origin, region: input.region, forcePathStyle: true,
    maxAttempts: 1, followRegionRedirects: false, requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED", requestHandler: input.requestHandler,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey } });
  const bucket = input.bucket; const prefix = input.prefix;
  const key = (value: string) => {
    if (value !== "head.json" && !/^bundles\/[0-9]+-[a-f0-9]{64}\.json$/.test(value)) refuse();
    return prefix + value;
  };
  const write = async (name: string, bytes: Buffer, conditional: { IfMatch: string } | { IfNoneMatch: "*" }) => {
    if (!bytes.length || bytes.length > CUSTODY_MAX_BYTES) refuse();
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key(name), Body: bytes,
        ExpectedBucketOwner: input.expectedBucketOwner, ContentType: "application/json", CacheControl: "no-store", ...conditional }), { abortSignal: AbortSignal.timeout(10_000) });
    } catch { refuse(); } // Includes 409/412/lost response: GET-only reconciliation, never retry.
  };
  return {
    async read(name) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(name), ExpectedBucketOwner: input.expectedBucketOwner }),
          { abortSignal: AbortSignal.timeout(10_000) });
        const body = response.Body;
        if (!(body instanceof Readable) || !response.ETag || !/^"[^"\r\n]{1,128}"$/.test(response.ETag)
          || (response.ContentLength !== undefined && response.ContentLength > CUSTODY_MAX_BYTES)) {
          if (body instanceof Readable) body.destroy(); refuse();
        }
        const chunks: Buffer[] = []; let size = 0;
        const timer = setTimeout(() => body.destroy(new Error("ERASURE_REMOTE_READ_TIMEOUT")), 10_000);
        try {
          for await (const value of body) {
            const bytes = Buffer.from(value); size += bytes.length;
            if (size > CUSTODY_MAX_BYTES) { body.destroy(); refuse(); }
            chunks.push(bytes);
          }
        } finally { clearTimeout(timer); }
        if (!size || (response.ContentLength !== undefined && response.ContentLength !== size)) refuse();
        return { bytes: Buffer.concat(chunks, size), etag: response.ETag };
      } catch (error) {
        // NoSuchKey is absence; a bucket/permission/transport error is never an empty ledger.
        if (error instanceof Error && error.name === "NoSuchKey"
          && (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        return refuse();
      }
    },
    create: (name, bytes) => write(name, bytes, { IfNoneMatch: "*" }),
    compareExchange: (name, bytes, etag) => {
      if (name !== "head.json" || !/^"[^"\r\n]{1,128}"$/.test(etag)) return refuse();
      return write(name, bytes, { IfMatch: etag });
    },
    close: () => client.destroy(),
  };
}
