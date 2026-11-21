import { createHash } from "node:crypto";

/**
 * FLEX-63 course media: the pure admission contract for owner-uploaded course images.
 *
 * Nothing here decodes pixels. The Hono writer only reads the container header to learn the
 * declared dimensions, so a hostile file cannot make the payment process spend unbounded CPU or
 * memory. Decoding and WebP encoding happen in the separate worker (course-media-worker.ts).
 * Image bytes never enter the merchant SQLite; only the metadata below does.
 */

export class CourseMediaError extends Error {
  constructor(readonly code: CourseMediaErrorCode) { super(code); }
}

export type CourseMediaErrorCode =
  | "MEDIA_EMPTY" | "MEDIA_TOO_LARGE" | "MEDIA_TYPE_UNSUPPORTED" | "MEDIA_TYPE_MISMATCH" | "MEDIA_CORRUPT"
  | "MEDIA_TOO_SMALL" | "MEDIA_DIMENSIONS_EXCEEDED" | "MEDIA_PIXELS_EXCEEDED" | "MEDIA_ALT_INVALID"
  | "MEDIA_COURSE_REF_INVALID" | "MEDIA_PUBLIC_URL_INVALID" | "MEDIA_VARIANTS_INVALID";

export type CourseMediaMime = "image/jpeg" | "image/png" | "image/webp";

export const COURSE_MEDIA_LIMITS = Object.freeze({
  /** Upload body bound, enforced before the bytes are buffered. */
  maxBytes: 15 * 1024 * 1024,
  /** Decompression-bomb bound on the header-declared size (≈ 160 MB RGBA once decoded). */
  maxPixels: 40_000_000,
  maxSide: 10_000,
  /** The largest variant is the 1920×1080 hero; a smaller source would only be upscaled. */
  minWidth: 1920,
  minHeight: 1080,
  maxAltLength: 300,
});

export type CourseMediaVariantName = "card" | "hero" | "og";
export type CourseMediaVariantSpec = { readonly name: CourseMediaVariantName; readonly width: number; readonly height: number };

/** The exact FLEX-63 variants. Every one is a WebP centre-crop (`cover`) to exactly these pixels. */
export const COURSE_MEDIA_VARIANTS: readonly CourseMediaVariantSpec[] = Object.freeze([
  { name: "card", width: 960, height: 640 },
  { name: "hero", width: 1920, height: 1080 },
  { name: "og", width: 1200, height: 630 },
]);

export type SniffedImage = { readonly mime: CourseMediaMime; readonly width: number; readonly height: number };

const u16be = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1];
const u24le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
const u32be = (bytes: Uint8Array, at: number) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const corrupt = (): never => { throw new CourseMediaError("MEDIA_CORRUPT"); };

function pngSize(bytes: Uint8Array): SniffedImage {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
  if (bytes.length < 33 || u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") corrupt();
  return { mime: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

// SOF markers carry the frame size. C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frames.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array): SniffedImage {
  let at = 2;
  // A bounded walk over segment headers; entropy-coded data is never scanned.
  for (let segments = 0; segments < 512 && at + 4 <= bytes.length; segments += 1) {
    if (bytes[at] !== 0xff) corrupt();
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = u16be(bytes, at + 2);
    if (length < 2) corrupt();
    if (JPEG_SOF.has(marker)) {
      if (at + 9 > bytes.length) corrupt();
      return { mime: "image/jpeg", height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return corrupt();
}

function webpSize(bytes: Uint8Array): SniffedImage {
  if (bytes.length < 30) corrupt();
  const riffLength = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  if (riffLength + 8 > bytes.length || riffLength < 22) corrupt();
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") return { mime: "image/webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) corrupt();
    return { mime: "image/webp", width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) corrupt();
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return corrupt();
}

/** Identifies the container from its magic bytes and reads the declared size from its header only. */
export function sniffImage(bytes: Uint8Array): SniffedImage {
  if (bytes.length === 0) throw new CourseMediaError("MEDIA_EMPTY");
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a
    && bytes[6] === 0x1a && bytes[7] === 0x0a) return pngSize(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpSize(bytes);
  throw new CourseMediaError("MEDIA_TYPE_UNSUPPORTED");
}

const normalizedMime = (value: string | null | undefined) => {
  const mime = value?.split(";", 1)[0].trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
};

/** Normalizes owner alt text; it is published verbatim as `alt` and `og:image:alt`. */
export function validateAltText(value: unknown): string {
  if (typeof value !== "string") throw new CourseMediaError("MEDIA_ALT_INVALID");
  const alt = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!alt || alt.length > COURSE_MEDIA_LIMITS.maxAltLength || /[\u0000-\u001f\u007f<>]/.test(alt)) {
    throw new CourseMediaError("MEDIA_ALT_INVALID");
  }
  return alt;
}

const courseRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/;

export type AdmittedCourseImage = SniffedImage & {
  readonly courseRef: string; readonly alt: string; readonly bytes: number; readonly sourceSha256: string;
};

/**
 * The upload admission decision. Order matters: size before parsing, header before pixels, and the
 * declared Content-Type must agree with the magic bytes so a renamed file cannot slip through.
 */
export function admitCourseImage(input: {
  courseRef: string; declaredMime: string | null | undefined; alt: unknown; bytes: Uint8Array;
}): AdmittedCourseImage {
  if (!courseRefPattern.test(input.courseRef)) throw new CourseMediaError("MEDIA_COURSE_REF_INVALID");
  if (input.bytes.length > COURSE_MEDIA_LIMITS.maxBytes) throw new CourseMediaError("MEDIA_TOO_LARGE");
  const alt = validateAltText(input.alt);
  const sniffed = sniffImage(input.bytes);
  if (normalizedMime(input.declaredMime) !== sniffed.mime) throw new CourseMediaError("MEDIA_TYPE_MISMATCH");
  const { width, height } = sniffed;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) corrupt();
  if (width > COURSE_MEDIA_LIMITS.maxSide || height > COURSE_MEDIA_LIMITS.maxSide) throw new CourseMediaError("MEDIA_DIMENSIONS_EXCEEDED");
  if (width * height > COURSE_MEDIA_LIMITS.maxPixels) throw new CourseMediaError("MEDIA_PIXELS_EXCEEDED");
  if (width < COURSE_MEDIA_LIMITS.minWidth || height < COURSE_MEDIA_LIMITS.minHeight) throw new CourseMediaError("MEDIA_TOO_SMALL");
  return {
    ...sniffed, courseRef: input.courseRef, alt, bytes: input.bytes.length,
    sourceSha256: createHash("sha256").update(input.bytes).digest("hex"),
  };
}

/**
 * Content-addressed object keys. The same source always maps to the same keys, so a retried stage
 * overwrites identical bytes instead of creating a second copy, and keys never collide across courses.
 */
export const courseMediaSourceKey = (courseRef: string, sourceSha256: string) =>
  `course-media/source/${encodeURIComponent(courseRef)}/${sourceSha256}`;
export const courseMediaVariantKey = (courseRef: string, sourceSha256: string, variant: CourseMediaVariantName) =>
  `course-media/public/${encodeURIComponent(courseRef)}/${sourceSha256.slice(0, 32)}/${variant}.webp`;

export type PublishedVariant = {
  readonly name: CourseMediaVariantName; readonly key: string; readonly width: number; readonly height: number;
  readonly bytes: number; readonly sha256: string;
};

/**
 * Validates what the worker reports back. Commerce trusts nothing it did not derive itself: the keys,
 * sizes and names must be exactly the ones this source would produce.
 */
export function validateWorkerVariants(courseRef: string, sourceSha256: string, value: unknown): PublishedVariant[] {
  if (!Array.isArray(value) || value.length !== COURSE_MEDIA_VARIANTS.length) throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
  return COURSE_MEDIA_VARIANTS.map((spec) => {
    const item = value.find((candidate) => (candidate as { name?: unknown })?.name === spec.name) as Record<string, unknown> | undefined;
    if (!item || Object.keys(item).some((key) => !["name", "key", "width", "height", "bytes", "sha256"].includes(key))
      || item.key !== courseMediaVariantKey(courseRef, sourceSha256, spec.name)
      || item.width !== spec.width || item.height !== spec.height
      || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 1 || (item.bytes as number) > COURSE_MEDIA_LIMITS.maxBytes
      || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
    return { name: spec.name, key: item.key, width: spec.width, height: spec.height, bytes: item.bytes as number, sha256: item.sha256 };
  });
}

/** The credential-free public origin; the same rule as apps/platform/lib/public-media.ts. */
export function courseMediaPublicBase(value: string | undefined): URL {
  let url: URL;
  try { url = new URL(value?.trim() ?? ""); } catch { throw new CourseMediaError("MEDIA_PUBLIC_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new CourseMediaError("MEDIA_PUBLIC_URL_INVALID");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

export const courseMediaPublicURL = (base: URL, key: string) => new URL(key, base).toString();
