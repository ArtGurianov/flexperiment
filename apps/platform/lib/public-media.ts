const DEFAULT_PUBLIC_MEDIA_URL = "https://flexperiment.s3.cloud.ru";

const encodePath = (value: string) => {
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("PUBLIC_MEDIA_PATH_INVALID");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
};

export function publicMediaBaseURL(value = process.env.S3_PUBLIC_URL): URL {
  const url = new URL(value?.trim() || DEFAULT_PUBLIC_MEDIA_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("S3_PUBLIC_URL_INVALID");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

export function publicMediaFileURL({ filename, prefix }: { filename: string; prefix?: string }): string {
  const baseURL = publicMediaBaseURL();
  const objectPath = [prefix, filename].filter((part): part is string => Boolean(part)).join("/");
  return new URL(encodePath(objectPath), baseURL).toString();
}

export function publicMediaRemotePattern() {
  const url = publicMediaBaseURL();
  return {
    protocol: "https" as const,
    hostname: url.hostname,
    port: url.port,
    pathname: `${url.pathname}**`,
    search: "",
  };
}

export function publicImageContentSecurityPolicy(): string {
  return `img-src 'self' data: blob: ${publicMediaBaseURL().origin} https://mc.yandex.ru;`;
}

export type CourseImageVariantName = "card" | "hero" | "og";
export type CourseImageVariant = { readonly url: string; readonly width: number; readonly height: number };
export type CourseImage = { readonly alt: string } & Readonly<Record<CourseImageVariantName, CourseImageVariant>>;

/** FLEX-63 variants. Must match commerce-v2/src/course-media.ts COURSE_MEDIA_VARIANTS. */
export const COURSE_IMAGE_VARIANTS: Readonly<Record<CourseImageVariantName, { width: number; height: number }>> = {
  card: { width: 960, height: 640 },
  hero: { width: 1920, height: 1080 },
  og: { width: 1200, height: 630 },
};

/**
 * Reads the optional `image` Commerce publishes for an activated course. Anything unexpected — a
 * missing variant, wrong size, foreign origin or non-WebP path — yields `null`, and pages render the
 * text-only fallback instead of a broken or third-party image.
 */
export function parseCourseImage(value: unknown, base: URL = publicMediaBaseURL()): CourseImage | null {
  if (!value || typeof value !== "object") return null;
  const { alt, variants } = value as { alt?: unknown; variants?: unknown };
  if (typeof alt !== "string" || !alt.trim() || alt.length > 300 || !Array.isArray(variants)) return null;
  const result: Partial<Record<CourseImageVariantName, CourseImageVariant>> = {};
  for (const [name, size] of Object.entries(COURSE_IMAGE_VARIANTS) as Array<[CourseImageVariantName, { width: number; height: number }]>) {
    const variant = variants.find((item) => (item as { name?: unknown })?.name === name) as { url?: unknown; width?: unknown; height?: unknown } | undefined;
    if (!variant || variant.width !== size.width || variant.height !== size.height || typeof variant.url !== "string") return null;
    let url: URL;
    try { url = new URL(variant.url); } catch { return null; }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || !url.pathname.endsWith(".webp")
      || url.search || url.hash || url.username || url.password) return null;
    result[name] = { url: url.toString(), ...size };
  }
  return { alt: alt.trim(), ...result } as CourseImage;
}
