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

/**
 * FLEX-63 Stage A (owner directive v4.8, 2026-11-22): course images are the accepted FLEX-126 WebP
 * artwork shipped with Platform under public/course-covers. Each entry is bound to one Commerce
 * `courseRef`; a course without an entry renders its text-only fallback. width/height/bytes/sha256
 * are the file's real values and are verified against the bytes by test/course-image-manifest.test.ts.
 *
 * The artwork is ~4:5 portrait, so it is published at its honest size for cards, hero and og:image;
 * no 3:2/16:9/1200×630 crop exists yet (that is the post-Stage-A Control Room upload).
 */
export type CourseImageEntry = {
  readonly courseRef: string;
  readonly path: `/course-covers/${string}.webp`;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
};

export const COURSE_IMAGE_MANIFEST: readonly CourseImageEntry[] = Object.freeze([
  { courseRef: "basics", path: "/course-covers/course-main-basics.webp", width: 1126, height: 1397, bytes: 51014, sha256: "b669071d408aea2ab1e3e1de180c99f927aae47b5df3f3c1a7038c4153ee44fb" },
  { courseRef: "bonebreaking", path: "/course-covers/course-main-bonebreaking.webp", width: 1122, height: 1402, bytes: 85816, sha256: "1fb295c81d38dc88d44aec2f7d5677499c23bf695083d8262863326ca0574ffd" },
  { courseRef: "brukup", path: "/course-covers/course-main-brukup.webp", width: 1122, height: 1402, bytes: 149794, sha256: "87dfebc94b2a90bd061c4e03a6f974a9995606e48397b0c53c9042b4d6add0ba" },
  { courseRef: "gliding", path: "/course-covers/course-main-gliding.webp", width: 1122, height: 1402, bytes: 138104, sha256: "c41b26cb7ea1f1ecae2d9808cae60acd436ba63e24388ab949858404bce94583" },
  { courseRef: "tutting", path: "/course-covers/course-main-tutting.webp", width: 1122, height: 1402, bytes: 72512, sha256: "fa4cccc031137fe4099e5da73211fdf03014296d0275c49d0491c1600ea49675" },
  { courseRef: "pauzin", path: "/course-covers/course-main-pauzin.webp", width: 1122, height: 1402, bytes: 82910, sha256: "ec92ad2462e8b56168fbc8fee446b65751d06f2c3946a9b441575c11c97b544d" },
  { courseRef: "get-low", path: "/course-covers/course-main-get-low.webp", width: 1122, height: 1402, bytes: 96406, sha256: "ba6c6660e03a70f5c771f38fd3ef51f59771277c1ac769e25b2a5a6391a5f360" },
  { courseRef: "powermoves", path: "/course-covers/course-main-powermoves.webp", width: 1122, height: 1402, bytes: 84994, sha256: "5769bcab5400da15997b2632e45ee473832920ad4310448f4915246f17ce9a7a" },
  { courseRef: "improvisation", path: "/course-covers/course-main-improvisation.webp", width: 1122, height: 1402, bytes: 85300, sha256: "f7ba52e2ecf6a9286da3bdb05b446298e7a4136bf99f9ba7019b0759560691ff" },
] satisfies CourseImageEntry[]);

export type CourseImage = {
  /** Site-relative path; resolve with the platform origin where an absolute URL is required. */
  readonly path: string; readonly width: number; readonly height: number; readonly alt: string;
};

const manifestByRef = new Map(COURSE_IMAGE_MANIFEST.map((entry) => [entry.courseRef, entry]));

/** The prepared image for a course, or `null` for the text-only fallback. Alt is derived from the title. */
export function courseImageFor(course: { readonly courseRef: string; readonly title: string }): CourseImage | null {
  const entry = manifestByRef.get(course.courseRef);
  const title = course.title.replace(/\s+/g, " ").trim();
  if (!entry || !title) return null;
  return { path: entry.path, width: entry.width, height: entry.height, alt: `Обложка курса «${title}»` };
}
