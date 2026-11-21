import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { sniffImage, type CourseMediaVariantName, type PublishedVariant } from "./course-media";
import type { CourseMediaFailure, CourseMediaJob, CourseMediaResult } from "./course-media-store";

/**
 * FLEX-63 image worker. It runs as its own constrained process, never inside the Commerce payment
 * API: it shares no filesystem with the merchant SQLite, holds the S3 keys the API does not need, and
 * talks to Commerce only through the scoped claim/complete calls below.
 */

export type ObjectStore = {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Decodes the source and encodes one WebP centre-crop to exactly width×height. */
export type ImageTransformer = (source: Uint8Array, target: { width: number; height: number }) => Promise<Uint8Array>;

export type CourseMediaApi = {
  claim(): Promise<CourseMediaJob | null>;
  complete(assetId: string, leaseToken: string, result: CourseMediaResult): Promise<void>;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class StageFailure extends Error {
  constructor(readonly code: CourseMediaFailure) { super(code); }
}

async function stage<T>(code: CourseMediaFailure, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof StageFailure) throw error;
    throw new StageFailure(code);
  }
}

/** One job: source read-back → transform → upload → public read-back. Every stage is idempotent. */
export async function processCourseMediaJob(
  job: CourseMediaJob, deps: { sourceStore: ObjectStore; publicStore: ObjectStore; transform: ImageTransformer },
): Promise<CourseMediaResult> {
  try {
    const source = await stage("SOURCE_MISSING", () => deps.sourceStore.get(job.sourceKey));
    if (!source) throw new StageFailure("SOURCE_MISSING");
    if (sha256(source) !== job.sourceSha256) throw new StageFailure("SOURCE_MISMATCH");
    const variants: PublishedVariant[] = [];
    for (const spec of job.variants) {
      const encoded = await stage("DECODE_FAILED", () => deps.transform(source, { width: spec.width, height: spec.height }));
      const sniffed = await stage("ENCODE_FAILED", async () => sniffImage(encoded));
      if (sniffed.mime !== "image/webp" || sniffed.width !== spec.width || sniffed.height !== spec.height) {
        throw new StageFailure("ENCODE_FAILED");
      }
      const digest = sha256(encoded);
      await stage("UPLOAD_FAILED", () => deps.publicStore.put(spec.key, encoded, "image/webp"));
      const readBack = await stage("READBACK_MISMATCH", () => deps.publicStore.get(spec.key));
      if (!readBack || sha256(readBack) !== digest) throw new StageFailure("READBACK_MISMATCH");
      variants.push({ name: spec.name as CourseMediaVariantName, key: spec.key, width: spec.width, height: spec.height,
        bytes: encoded.length, sha256: digest });
    }
    return { outcome: "READY", variants };
  } catch (error) {
    if (error instanceof StageFailure) return { outcome: "FAILED", errorCode: error.code };
    throw error;
  }
}

/** Drains the queue once. A crash mid-job leaves the lease to expire, and the job is re-claimed. */
export async function runCourseMediaWorkerOnce(
  api: CourseMediaApi, deps: Parameters<typeof processCourseMediaJob>[1], maxJobs = 10,
): Promise<number> {
  let processed = 0;
  for (; processed < maxJobs; processed += 1) {
    const job = await api.claim();
    if (!job) break;
    await api.complete(job.assetId, job.leaseToken, await processCourseMediaJob(job, deps));
  }
  return processed;
}

/**
 * Cloud.ru S3 is S3-compatible; this adapter is the only place that holds a client. Variants are
 * public-read and immutable (content-addressed keys), so they can be cached for a year.
 */
export function s3ObjectStore(client: S3Client, bucket: string, options: { publicRead: boolean }): ObjectStore {
  return {
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return object.Body ? await object.Body.transformToByteArray() : null;
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes, ContentType: contentType,
        ChecksumSHA256: Buffer.from(createHash("sha256").update(bytes).digest()).toString("base64"),
        ...(options.publicRead ? { ACL: "public-read" as const, CacheControl: "public, max-age=31536000, immutable" } : {}),
      }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

/** Scoped worker client: the bearer token authorizes only claim/complete, never any other Commerce route. */
export function httpCourseMediaApi(origin: string, token: string, fetcher: typeof fetch = fetch): CourseMediaApi {
  const call = async (path: string, body: unknown) => {
    const response = await fetcher(new URL(path, origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 204) throw new Error(`COURSE_MEDIA_API_${response.status}`);
    return response.status === 204 ? null : await response.json();
  };
  return {
    claim: async () => (await call("/v1/course-media-worker/claim", {}) as { job: CourseMediaJob | null } | null)?.job ?? null,
    complete: async (assetId, leaseToken, result) => {
      await call(`/v1/course-media-worker/${encodeURIComponent(assetId)}/complete`, { leaseToken, result });
    },
  };
}
