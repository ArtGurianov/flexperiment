import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import {
  admitCourseImage, COURSE_MEDIA_VARIANTS, courseMediaPublicBase, courseMediaPublicURL, courseMediaSourceKey,
  courseMediaVariantKey, sniffImage, validateAltText,
} from "../src/course-media";
import {
  activateCourseMedia, claimCourseMediaJob, completeCourseMediaJob, COURSE_MEDIA_DDL_PROPOSAL, courseMediaOrphans,
  discardCourseMedia, getCourseMediaAsset, MAX_COURSE_MEDIA_ATTEMPTS, publicCourseImage, registerCourseMediaUpload,
} from "../src/course-media-store";
import { processCourseMediaJob, runCourseMediaWorkerOnce, type CourseMediaApi, type ImageTransformer, type ObjectStore } from "../src/course-media-worker";
import { registerCourseMediaRoutes } from "../src/course-media-routes";

// Header-only fixtures: enough for the container sniffer, which by design never decodes pixels.
const png = (width: number, height: number, tail = 64) => {
  const bytes = new Uint8Array(33 + tail);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};
const jpeg = (width: number, height: number) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0),
  0xff, 0xc2, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 0, 0, 0xff, 0xd9,
]);
const webp = (width: number, height: number, salt = 0) => {
  const bytes = new Uint8Array(64);
  bytes.set([...Buffer.from("RIFF"), 56, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0x10, 0, 0, 0]);
  const w = width - 1; const h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  bytes[40] = salt;
  return bytes;
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  migrateV2(db);
  db.exec(COURSE_MEDIA_DDL_PROPOSAL);
});

describe("course media admission", () => {
  it("reads declared sizes of PNG, progressive JPEG and WebP from headers only", () => {
    expect(sniffImage(png(2400, 1600))).toEqual({ mime: "image/png", width: 2400, height: 1600 });
    expect(sniffImage(jpeg(3000, 2000))).toEqual({ mime: "image/jpeg", width: 3000, height: 2000 });
    expect(sniffImage(webp(1122, 1402))).toEqual({ mime: "image/webp", width: 1122, height: 1402 });
  });

  it("admits a large-enough image and fingerprints the exact bytes", () => {
    const bytes = png(2400, 1600);
    const admitted = admitCourseImage({ courseRef: "course", declaredMime: "image/png", alt: "  Танцор \n в прыжке ", bytes });
    expect(admitted).toMatchObject({ mime: "image/png", width: 2400, height: 1600, alt: "Танцор в прыжке", sourceSha256: sha(bytes) });
  });

  it.each([
    ["empty", new Uint8Array(), "image/png", "MEDIA_EMPTY"],
    ["wrong magic", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", "MEDIA_TYPE_UNSUPPORTED"],
    ["renamed file", png(2400, 1600), "image/jpeg", "MEDIA_TYPE_MISMATCH"],
    ["truncated PNG", png(2400, 1600).subarray(0, 20), "image/png", "MEDIA_CORRUPT"],
    ["corrupt JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00]), "image/jpeg", "MEDIA_CORRUPT"],
    ["too small for hero", webp(1122, 1402), "image/webp", "MEDIA_TOO_SMALL"],
    ["side over limit", png(12_000, 1200), "image/png", "MEDIA_DIMENSIONS_EXCEEDED"],
    ["pixel bomb", png(9000, 9000), "image/png", "MEDIA_PIXELS_EXCEEDED"],
    ["oversize body", new Uint8Array(15 * 1024 * 1024 + 1), "image/png", "MEDIA_TOO_LARGE"],
  ])("rejects %s", (_name, bytes, declaredMime, code) => {
    expect(() => admitCourseImage({ courseRef: "course", declaredMime, alt: "Обложка", bytes })).toThrow(code);
  });

  it("requires plain, bounded alt text", () => {
    for (const alt of ["", "   ", "x".repeat(301), "<script>", "a\u0000b", 42]) expect(() => validateAltText(alt)).toThrow("MEDIA_ALT_INVALID");
  });

  it("derives content-addressed keys and a credential-free https public origin", () => {
    const digest = "a".repeat(64);
    expect(courseMediaVariantKey("course:one", digest, "og")).toBe(`course-media/public/course%3Aone/${"a".repeat(32)}/og.webp`);
    expect(courseMediaSourceKey("course", digest)).toBe(`course-media/source/course/${digest}`);
    const base = courseMediaPublicBase("https://flexperiment.s3.cloud.ru/media");
    expect(courseMediaPublicURL(base, "course-media/public/x/og.webp")).toBe("https://flexperiment.s3.cloud.ru/media/course-media/public/x/og.webp");
    for (const bad of ["http://cdn.test", "https://key:secret@cdn.test", "https://cdn.test/?sig=1", "not a url", undefined]) {
      expect(() => courseMediaPublicBase(bad)).toThrow("MEDIA_PUBLIC_URL_INVALID");
    }
  });
});

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  failPut = false;
  corruptReadBack = false;
  async get(key: string) {
    const value = this.objects.get(key);
    return value && this.corruptReadBack ? new Uint8Array([...value, 1]) : value ?? null;
  }
  async put(key: string, bytes: Uint8Array) {
    if (this.failPut) throw new Error("S3 unavailable");
    this.objects.set(key, bytes);
  }
  async delete(key: string) { this.objects.delete(key); }
}

const transform: ImageTransformer = async (_source, target) => webp(target.width, target.height, target.width % 251);

function upload(bytes = png(2400, 1600), store = new MemoryStore()) {
  const image = admitCourseImage({ courseRef: "course", declaredMime: "image/png", alt: "Обложка курса", bytes });
  void store.put(courseMediaSourceKey("course", image.sourceSha256), bytes);
  return { ...registerCourseMediaUpload(db, image, "admin", "2026-11-20T10:00:00.000Z"), store };
}

const localApi = (): CourseMediaApi => ({
  claim: async () => claimCourseMediaJob(db, 60_000, new Date("2026-11-20T10:01:00.000Z")),
  complete: async (assetId, leaseToken, result) => { completeCourseMediaJob(db, assetId, leaseToken, result); },
});

describe("course media pipeline", () => {
  it("transforms, uploads, reads back and only then lets the owner activate the image", async () => {
    const { asset, store } = upload();
    const publicStore = new MemoryStore();
    expect(publicCourseImage(db, "course", (key) => `https://cdn.test/${key}`)).toBeNull();

    expect(await runCourseMediaWorkerOnce(localApi(), { sourceStore: store, publicStore, transform })).toBe(1);
    const ready = getCourseMediaAsset(db, asset.assetId)!;
    expect(ready.state).toBe("READY");
    expect(ready.variants!.map(({ name, width, height }) => [name, width, height])).toEqual([
      ["card", 960, 640], ["hero", 1920, 1080], ["og", 1200, 630],
    ]);
    for (const variant of ready.variants!) expect(sha(publicStore.objects.get(variant.key)!)).toBe(variant.sha256);

    // READY is not published: the storefront keeps its fallback until the owner activates.
    expect(publicCourseImage(db, "course", (key) => `https://cdn.test/${key}`)).toBeNull();
    activateCourseMedia(db, asset.assetId, "admin");
    const image = publicCourseImage(db, "course", (key) => `https://cdn.test/${key}`)!;
    expect(image.alt).toBe("Обложка курса");
    expect(image.variants.find((item) => item.name === "og")).toEqual({
      name: "og", width: 1200, height: 630, url: `https://cdn.test/${courseMediaVariantKey("course", asset.sourceSha256, "og")}`,
    });
    expect(JSON.stringify(image)).not.toContain("source");
  });

  it("deduplicates a re-upload of the same bytes and keeps one source object", () => {
    const first = upload();
    const second = upload(png(2400, 1600), first.store);
    expect(second.replayed).toBe(true);
    expect(second.asset.assetId).toBe(first.asset.assetId);
    expect(db.prepare("SELECT count(*) AS n FROM course_media_assets").get()).toEqual({ n: 1 });
  });

  it.each([
    ["missing source", (store: MemoryStore) => store.objects.clear(), "SOURCE_MISSING"],
    ["tampered source", (store: MemoryStore) => store.objects.forEach((_v, key) => store.objects.set(key, png(2400, 1601))), "SOURCE_MISMATCH"],
  ])("fails on %s without touching the published image", async (_name, damage, code) => {
    const published = upload(png(2400, 1600));
    await runCourseMediaWorkerOnce(localApi(), { sourceStore: published.store, publicStore: new MemoryStore(), transform });
    activateCourseMedia(db, published.asset.assetId, "admin");
    const before = publicCourseImage(db, "course", (key) => key);

    const next = upload(png(3000, 2000));
    damage(next.store);
    await runCourseMediaWorkerOnce(localApi(), { sourceStore: next.store, publicStore: new MemoryStore(), transform });
    expect(getCourseMediaAsset(db, next.asset.assetId)).toMatchObject({ state: "FAILED", errorCode: code, variants: null });
    expect(publicCourseImage(db, "course", (key) => key)).toEqual(before);
    expect(() => activateCourseMedia(db, next.asset.assetId, "admin")).toThrow();
  });

  it("rejects a transformer output that is not the exact WebP variant", async () => {
    const { store } = upload();
    const job = claimCourseMediaJob(db)!;
    const wrongSize: ImageTransformer = async () => webp(1000, 1000);
    const pngOut: ImageTransformer = async (_s, t) => png(t.width, t.height);
    const crash: ImageTransformer = async () => { throw new Error("libvips: VipsJpeg: premature end"); };
    for (const [transformer, code] of [[wrongSize, "ENCODE_FAILED"], [pngOut, "ENCODE_FAILED"], [crash, "DECODE_FAILED"]] as const) {
      expect(await processCourseMediaJob(job, { sourceStore: store, publicStore: new MemoryStore(), transform: transformer }))
        .toEqual({ outcome: "FAILED", errorCode: code });
    }
  });

  it("retries transient upload and read-back failures within the attempt budget, then fails", async () => {
    const { asset, store } = upload();
    const publicStore = new MemoryStore();
    publicStore.failPut = true;
    let now = Date.parse("2026-11-20T10:01:00.000Z");
    const api: CourseMediaApi = {
      claim: async () => claimCourseMediaJob(db, 60_000, new Date(now += 1000)),
      complete: async (id, lease, result) => { completeCourseMediaJob(db, id, lease, result); },
    };
    await runCourseMediaWorkerOnce(api, { sourceStore: store, publicStore, transform }, 1);
    expect(getCourseMediaAsset(db, asset.assetId)).toMatchObject({ state: "PENDING", errorCode: "UPLOAD_FAILED", attempts: 1 });
    publicStore.failPut = false;
    publicStore.corruptReadBack = true;
    await runCourseMediaWorkerOnce(api, { sourceStore: store, publicStore, transform }, MAX_COURSE_MEDIA_ATTEMPTS);
    expect(getCourseMediaAsset(db, asset.assetId)).toMatchObject({ state: "FAILED", errorCode: "READBACK_MISMATCH", attempts: 3 });
  });

  it("re-claims a job whose worker crashed after its lease expired, and fences the stale lease", () => {
    const { asset } = upload();
    const stale = claimCourseMediaJob(db, 60_000, new Date("2026-11-20T10:00:00.000Z"))!;
    expect(claimCourseMediaJob(db, 60_000, new Date("2026-11-20T10:00:30.000Z"))).toBeNull();
    const fresh = claimCourseMediaJob(db, 60_000, new Date("2026-11-20T10:02:00.000Z"))!;
    expect(fresh.assetId).toBe(asset.assetId);
    const variants = fresh.variants.map((v) => ({ ...v, bytes: 10, sha256: "b".repeat(64) }));
    expect(() => completeCourseMediaJob(db, asset.assetId, stale.leaseToken, { outcome: "READY", variants })).toThrow();
    expect(completeCourseMediaJob(db, asset.assetId, fresh.leaseToken, { outcome: "READY", variants }).replayed).toBe(false);
    // An identical repeated report (lost HTTP response) is an idempotent replay.
    expect(completeCourseMediaJob(db, asset.assetId, fresh.leaseToken, { outcome: "READY", variants }).replayed).toBe(true);
  });

  it("refuses worker reports with foreign keys, sizes or free-text errors", () => {
    const { asset } = upload();
    const job = claimCourseMediaJob(db)!;
    const good = job.variants.map((v) => ({ ...v, bytes: 10, sha256: "c".repeat(64) }));
    const attempts = [
      good.map((v, i) => i === 0 ? { ...v, key: "course-media/public/other/x/card.webp" } : v),
      good.map((v, i) => i === 1 ? { ...v, width: 1919 } : v),
      good.map((v, i) => i === 2 ? { ...v, url: "https://evil.test/x" } : v),
      good.slice(0, 2),
    ];
    for (const variants of attempts) {
      expect(() => completeCourseMediaJob(db, asset.assetId, job.leaseToken, { outcome: "READY", variants })).toThrow("MEDIA_VARIANTS_INVALID");
    }
    expect(() => completeCourseMediaJob(db, asset.assetId, job.leaseToken, { outcome: "FAILED", errorCode: "<b>boom</b>" })).toThrow();
    expect(getCourseMediaAsset(db, asset.assetId)!.state).toBe("PROCESSING");
  });

  it("lists failed and superseded objects for cleanup but never the active image", async () => {
    const first = upload(png(2400, 1600));
    await runCourseMediaWorkerOnce(localApi(), { sourceStore: first.store, publicStore: new MemoryStore(), transform });
    activateCourseMedia(db, first.asset.assetId, "admin");
    const second = upload(png(3000, 2000));
    await runCourseMediaWorkerOnce(localApi(), { sourceStore: second.store, publicStore: new MemoryStore(), transform });
    activateCourseMedia(db, second.asset.assetId, "admin");

    const orphans = courseMediaOrphans(db, "2099-01-01T00:00:00.000Z");
    expect(orphans.map((item) => item.assetId)).toEqual([first.asset.assetId]);
    expect(orphans[0].keys).toHaveLength(1 + COURSE_MEDIA_VARIANTS.length);
    expect(discardCourseMedia(db, first.asset.assetId)).toBe(true);
    expect(discardCourseMedia(db, second.asset.assetId)).toBe(false);
    expect(courseMediaOrphans(db, "2099-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("course media routes", () => {
  const app = (deps: Partial<Parameters<typeof registerCourseMediaRoutes>[1]> = {}) => {
    const hono = new Hono<{ Variables: { controlRoomAdminId?: string } }>();
    // Stands in for app.ts' Control Room session middleware, which runs before these routes.
    hono.use("/v1/admin/*", async (context, next) => {
      if (context.req.header("cookie") !== "session=ok") return context.json({ error: { code: "ADMIN_AUTH_REQUIRED" } }, 401);
      context.set("controlRoomAdminId", "admin-1");
      await next();
    });
    registerCourseMediaRoutes(hono, { db, sourceStore: new MemoryStore(), workerToken: "w".repeat(40), ...deps });
    return hono;
  };
  const post = (hono: Hono<never>, body: Uint8Array, type = "image/png", cookie = "session=ok") =>
    hono.request("/v1/admin/v2/courses/course/media", {
      method: "POST", body, headers: { cookie, "content-type": type, "x-media-alt": encodeURIComponent("Обложка") },
    });

  beforeEach(() => {
    db.prepare(`INSERT INTO course_editorial_drafts(course_ref,revision,document_json,actor,created_at,updated_at)
      VALUES ('course',1,'{}','admin','2026-11-20','2026-11-20')`).run();
  });

  it("accepts an authorized upload and maps rejections to bounded status codes", async () => {
    const hono = app() as unknown as Hono<never>;
    expect((await post(hono, png(2400, 1600))).status).toBe(202);
    expect((await post(hono, png(2400, 1600))).status).toBe(200);
    expect((await post(hono, png(2400, 1600), "image/jpeg")).status).toBe(415);
    expect((await post(hono, png(800, 600))).status).toBe(422);
    expect((await post(hono, new Uint8Array(15 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await post(hono, png(2400, 1600), "image/png", "")).status).toBe(401);
    expect(db.prepare("SELECT actor FROM course_media_assets").all()).toEqual([{ actor: "admin-1" }]);
  });

  it("reports 503 instead of accepting uploads before storage is configured", async () => {
    expect((await post(app({ sourceStore: undefined }) as unknown as Hono<never>, png(2400, 1600))).status).toBe(503);
  });

  it("scopes the worker API to its own token", async () => {
    const hono = app();
    const claim = (token?: string) => hono.request("/v1/course-media-worker/claim", {
      method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect((await claim()).status).toBe(401);
    expect((await claim("x".repeat(40))).status).toBe(401);
    expect(await (await claim("w".repeat(40))).json()).toEqual({ job: null });
    expect((await hono.request("/v1/admin/v2/course-media/x", { headers: { authorization: `Bearer ${"w".repeat(40)}` } })).status).toBe(401);
  });
});
