import type Database from "better-sqlite3";

/**
 * FLEX-70 IndexNow notification from Commerce, the authority for publish, unlist, relist and withdraw.
 *
 * Sending public URLs to a search engine is an external disclosure, so it is OFF unless the owner
 * enables it at public opening: INDEXNOW_ENABLED=true, DEPLOY_ENV=production, a valid INDEXNOW_KEY and
 * an https platform origin are all required. It is best effort and never proves indexing.
 *
 * Not wired yet: the signature matches app.ts' post-change hook, but that hook is the retired platform
 * revalidation seam guarded by apps/platform/test/local-api-boundary.test.ts, so wiring waits for a
 * dedicated hook. The returned function never throws and never waits on the network, so a slow or
 * failing IndexNow can neither delay nor fail an owner command.
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
  /** One notification per course per window; publish followed by a price edit sends once. */
  readonly dedupeMs?: number;
  readonly log?: (event: Record<string, unknown>) => void;
};

export type PlatformInvalidation = (mode: "swr" | "immediate", courseRef?: string, reason?: "WITHDRAWN") => Promise<void>;

export function createIndexNowNotifier(config: IndexNowConfig): PlatformInvalidation | undefined {
  const key = config.environment.INDEXNOW_KEY?.trim() ?? "";
  if (config.environment.INDEXNOW_ENABLED !== "true" || config.deployEnvironment !== "production") return undefined;
  if (!indexNowPayload(config.platformOrigin, key, ["probe"])) {
    config.log?.({ event: "indexnow.disabled", reason: "INDEXNOW_CONFIG_INVALID" });
    return undefined;
  }
  const fetcher = config.fetcher ?? fetch;
  const now = config.now ?? Date.now;
  const dedupeMs = config.dedupeMs ?? 10 * 60_000;
  const lastSent = new Map<string, number>();
  // Any visibility: an unlisted or withdrawn course still needs its URL re-crawled to drop it.
  const slugOf = config.db.prepare("SELECT slug FROM catalog_course_projection WHERE course_ref=?");

  return async (_mode, courseRef) => {
    try {
      if (!courseRef) return;
      const at = now();
      if ((lastSent.get(courseRef) ?? -Infinity) > at - dedupeMs) return;
      const row = slugOf.get(courseRef) as { slug: string | null } | undefined;
      const body = row?.slug ? indexNowPayload(config.platformOrigin, key, [row.slug]) : null;
      if (!body) return;
      lastSent.set(courseRef, at);
      void fetcher(INDEXNOW_ENDPOINT, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
      }).then((response) => {
        config.log?.({ event: "indexnow.sent", courseRef, status: response.status });
      }, () => {
        config.log?.({ event: "indexnow.failed", courseRef });
      });
    } catch {
      config.log?.({ event: "indexnow.failed", courseRef });
    }
  };
}
