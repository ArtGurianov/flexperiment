import type Database from "better-sqlite3";
import { parseCatalogueCommandRequest, performCertificationCatalogueCommand } from "../../src/certification/catalogue-endpoint";
import type { OccurrenceView } from "../../src/certification/evidence";
import { CERTIFICATION_OCCURRENCE_TITLE, CERTIFICATION_PRICE_KOPECKS, CERTIFICATION_TIMEZONE } from "../../src/certification/scope";

/**
 * The deployed runtime's side of the certification wire, and nothing else.
 *
 * Requests the runner's real HTTP port sends are parsed and admitted by the
 * real endpoint functions against the given database - what the commerce
 * container executes. The occurrence itself is a stub; admission, the run and
 * the ledger are not. Anything past the catalogue answers 503.
 */
export const certificationRuntime = (options: {
  readonly db: Database.Database;
  readonly sha: string;
  readonly now: Date;
  readonly citySlug: string;
  readonly legal: { readonly version: string; readonly manifestSha256: string };
}): typeof globalThis.fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const { db, sha, now } = options;
  const url = new URL(String(input));
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  if (url.pathname === "/v1/certification/runtime") {
    const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((row) => row.version);
    const unit = { sourceCommit: sha, startedAt: now.toISOString(), heartbeatAt: now.toISOString(), lastSuccessfulSweepAt: now.toISOString() };
    return respond(200, { evidence: { commerce: unit, worker: unit, schema: { lineage: "SUPPORTED", versions }, legal: options.legal } });
  }
  if (url.pathname === "/v1/certification/city") {
    const city = db.prepare("SELECT id FROM cities WHERE slug = ?").get(url.searchParams.get("slug")) as { id: string } | undefined;
    return respond(200, { city_id: city?.id });
  }
  if (url.pathname === "/v1/certification/catalogue-command") {
    const view = (id: string, revision: number): OccurrenceView => ({
      id, city_slug: options.citySlug, title: CERTIFICATION_OCCURRENCE_TITLE, timezone: CERTIFICATION_TIMEZONE,
      price_kopecks: CERTIFICATION_PRICE_KOPECKS, capacity: 1, visibility: "HIDDEN", sales_status: "CLOSED", admin_revision: revision,
    });
    try {
      const request = parseCatalogueCommandRequest(JSON.parse(String(init?.body)));
      const occurrence = performCertificationCatalogueCommand({
        db, now: () => now, runtimeReleaseSha: () => sha,
        createOccurrence: () => view(`occurrence-${request.runId}`, 1),
        readOccurrence: (id) => view(id, 1),
        patchOccurrence: (id) => view(id, 2),
      }, request);
      return respond(200, { occurrence });
    } catch (error) {
      // What the server logs, so a failure names the refusal.
      return respond(500, { error: { code: error instanceof Error ? error.message : "INTERNAL_ERROR" } });
    }
  }
  return respond(503, { error: { code: "NOT_IN_THIS_TEST" } });
}) as typeof globalThis.fetch;
