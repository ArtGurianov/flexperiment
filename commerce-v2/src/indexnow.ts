import type Database from "better-sqlite3";

/**
 * FLEX-70 IndexNow notification from Commerce, the authority for publish, unlist, relist and withdraw.
 *
 * Sending public URLs to a search engine is an external disclosure, so it is OFF unless the owner
 * enables it at public opening: INDEXNOW_ENABLED=true, DEPLOY_ENV=production, a valid INDEXNOW_KEY and
 * an https platform origin are all required. It is best effort and never proves indexing.
 *
 * Wired through app.ts' dedicated `notifyPublicCourseChange` dependency (not the retired platform
 * revalidation hook). The returned function never throws and never waits on the network, so a slow
 * or failing IndexNow can neither delay nor fail an owner command.
 */

const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const INDEXNOW_ENDPOINT = "https://yandex.com/indexnow";

/** The request body for one batch of canonical course URLs (same contract as apps/platform/lib/seo.ts). */
export function indexNowPayload(origin: string, key: string, slugs: readonly string[]) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || !KEY_PATTERN.test(key)) return null;
  const urlList = [...new Set(slugs.filter((slug) => SLUG_PATTERN.test(slug)))]
    .map((slug) => new URL(`/courses/${slug}`, base).toString());
  if (!urlList.length) return null;
  return { host: base.host, key, keyLocation: new URL("/indexnow-key.txt", base).toString(), urlList };
}

export type IndexNowConfig = {
  readonly db: Database.Database;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly deployEnvironment: string;
  readonly platformOrigin: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  /** Suppress repeated submissions of the same public course state within this window. */
  readonly dedupeMs?: number;
  readonly log?: (event: Record<string, unknown>) => void;
};

export type PublicCourseChangeNotifier = (courseRef: string) => void;

export function createIndexNowNotifier(config: IndexNowConfig): PublicCourseChangeNotifier | undefined {
  const key = config.environment.INDEXNOW_KEY?.trim() ?? "";
  if (config.environment.INDEXNOW_ENABLED !== "true" || config.deployEnvironment !== "production") return undefined;
  if (!indexNowPayload(config.platformOrigin, key, ["probe"])) {
    config.log?.({ event: "indexnow.disabled", reason: "INDEXNOW_CONFIG_INVALID" });
    return undefined;
  }
  const fetcher = config.fetcher ?? fetch;
  const now = config.now ?? Date.now;
  const dedupeMs = config.dedupeMs ?? 10 * 60_000;
  const submissions = new Map<string, { state: string; sentAt?: number }>();
  // Any visibility: an unlisted or withdrawn course still needs its URL re-crawled to drop it.
  const courseState = config.db.prepare(`SELECT course.slug, course.version, course.visibility,
    EXISTS (SELECT 1 FROM products WHERE kind='ONLINE_COURSE' AND course_ref=course.course_ref AND withdrawn_at IS NOT NULL) AS withdrawn
    FROM catalog_course_projection AS course WHERE course.course_ref=?`);

  return (courseRef) => {
    let submission: { state: string; sentAt?: number } | undefined;
    const failed = (status?: number) => {
      if (submission && submissions.get(courseRef) === submission) submissions.delete(courseRef);
      config.log?.({ event: "indexnow.failed", courseRef, ...(status === undefined ? {} : { status }) });
    };
    try {
      if (!courseRef) return;
      const row = courseState.get(courseRef) as { slug: string | null; version: number; visibility: string; withdrawn: number } | undefined;
      if (!row?.slug) return;
      const state = JSON.stringify([row.slug, row.version, row.visibility, row.withdrawn]);
      const previous = submissions.get(courseRef);
      if (previous?.state === state && (previous.sentAt === undefined || previous.sentAt > now() - dedupeMs)) return;
      const body = indexNowPayload(config.platformOrigin, key, [row.slug]);
      if (!body) return;
      const attempt = { state, sentAt: undefined as number | undefined };
      submission = attempt;
      submissions.set(courseRef, attempt);
      void fetcher(INDEXNOW_ENDPOINT, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
      }).then((response) => {
        if (!response.ok) { failed(response.status); return; }
        attempt.sentAt = now();
        config.log?.({ event: "indexnow.sent", courseRef, status: response.status });
      }, () => failed());
    } catch {
      failed();
    }
  };
}
