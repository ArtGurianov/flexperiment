import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { CommerceDomain } from "../domain";
import { DomainError } from "../domain";
import { activeLegalBinding } from "../release/legal-binding";
import { DatabaseRuntimeEvidenceReader } from "../release/topology-reader";
import { authenticateCertificationService, parseCatalogueCommandRequest, performCertificationCatalogueCommand, CertificationEndpointError } from "./catalogue-endpoint";
import { SqliteCatalogueMutationLedger } from "./catalogue-authority-sqlite";
import { CERTIFICATION_ADMIN_ID, CERTIFICATION_CANCELLATION_CONFIRMATION, CERTIFICATION_OCCURRENCE_TITLE, CERTIFICATION_PRICE_KOPECKS, CERTIFICATION_TIMEZONE } from "./scope";
import type { OccurrenceView } from "./evidence";

/**
 * Everything a certification may ask of the running system, behind one machine
 * credential and nothing else.
 *
 * It is mounted beside `/v1/admin`, never inside it. The admin router
 * authenticates a person's browser session and carries every ordinary
 * administrative route; a token that could reach those would be a second admin
 * credential living on a release host. Every route here is scoped to a run:
 * the reads answer about that run's own order and its own occurrence, and the
 * one mutation is the narrow catalogue command.
 */

const occurrenceRow = (db: Database.Database, occurrenceId: string): OccurrenceView => {
  const row = db.prepare(`SELECT o.id, o.title, o.admin_revision, o.visibility, o.sales_status, o.fulfillment_status,
      o.timezone, o.price_kopecks, o.capacity, o.starts_at, o.ends_at, c.slug AS city_slug
    FROM occurrences o JOIN cities c ON c.id = o.city_id WHERE o.id = ?`).get(occurrenceId);
  if (!row) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
  return row as unknown as OccurrenceView;
};

/**
 * The occurrence a run is allowed to ask about: its own, and only once it has
 * created one. Without this the credential would read any event in the
 * catalogue by id.
 */
const runOccurrence = (db: Database.Database, runId: string, occurrenceId: string): OccurrenceView => {
  const created = new SqliteCatalogueMutationLedger(db, runId).occurrenceId();
  if (!created || created !== occurrenceId) throw new CertificationEndpointError("CERTIFICATION_OCCURRENCE_NOT_THIS_RUN", 403, occurrenceId);
  return occurrenceRow(db, occurrenceId);
};

/** The run's own order, proved through the order's recorded run rather than assumed. */
const runOrder = (db: Database.Database, runId: string, orderId: string): void => {
  const row = db.prepare("SELECT certification_run_id FROM orders WHERE id = ?").get(orderId) as { certification_run_id: string | null } | undefined;
  if (!row) throw new DomainError("ORDER_NOT_FOUND", 404);
  if (row.certification_run_id !== runId) throw new CertificationEndpointError("CERTIFICATION_ORDER_NOT_THIS_RUN", 403, orderId);
};

export const createCertificationServiceRouter = (sqlite: Database.Database, domain: CommerceDomain) => {
  const router = new Hono();

  router.use("*", async (c, next) => {
    authenticateCertificationService(c.req.header("Authorization"), process.env.COMMERCE_CERTIFICATION_TOKEN_SHA256);
    c.res.headers.set("Cache-Control", "no-store");
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  /** What readiness judges, plus the commit this process is actually serving. */
  router.get("/runtime", async (c) => c.json({
    source_commit: process.env.SOURCE_COMMIT?.trim() ?? null,
    evidence: await new DatabaseRuntimeEvidenceReader({ db: sqlite, legal: () => activeLegalBinding(sqlite) }).read(),
  }));

  router.get("/city", (c) => {
    const row = sqlite.prepare("SELECT id FROM cities WHERE slug = ?").get(c.req.query("slug") ?? "") as { id: string } | undefined;
    return c.json({ city_id: row?.id ?? null });
  });

  router.post("/catalogue-command", async (c) => {
    const request = parseCatalogueCommandRequest(await c.req.json());
    const occurrence = performCertificationCatalogueCommand({
      db: sqlite,
      now: () => new Date(),
      runtimeReleaseSha: () => process.env.SOURCE_COMMIT?.trim() ?? "",
      readOccurrence: (occurrenceId) => occurrenceRow(sqlite, occurrenceId),
      createOccurrence: (draft, commandId, reason) => domain.withAdminCommandCore("occurrence-create", commandId, { ...draft, audit_context: reason }, "occurrences", () =>
        domain.createOccurrenceRecord({
          city_id: draft.cityId, title: CERTIFICATION_OCCURRENCE_TITLE,
          starts_at: draft.startsAt, ends_at: draft.endsAt, timezone: CERTIFICATION_TIMEZONE,
          price_kopecks: CERTIFICATION_PRICE_KOPECKS, capacity: 1, venue_status: "TO_BE_ANNOUNCED",
          venue_disclosure_text: draft.venueDisclosureText, venue_announce_by: draft.venueAnnounceBy,
        })).row as unknown as OccurrenceView,
      patchOccurrence: (occurrenceId, patch, expectedRevision, commandId, reason) =>
        domain.patchOccurrenceCore(occurrenceId, { ...patch, expected_revision: expectedRevision, audit_context: reason }, commandId, CERTIFICATION_ADMIN_ID) as unknown as OccurrenceView,
    }, request);
    return c.json({ occurrence });
  });

  /**
   * What a run's create command already produced, read from the ledger rather
   * than from a response nobody received. This is how a run whose creation
   * response was lost learns the occurrence it made instead of orphaning it.
   */
  router.get("/run/:runId/occurrence", (c) => {
    const occurrenceId = new SqliteCatalogueMutationLedger(sqlite, c.req.param("runId")).occurrenceId();
    return c.json({ occurrence: occurrenceId ? occurrenceRow(sqlite, occurrenceId) : null });
  });

  /** The run's occurrence, with the two facts cleanup has to prove publicly. */
  router.get("/run/:runId/occurrence/:id", (c) => {
    const runId = c.req.param("runId");
    const occurrence = runOccurrence(sqlite, runId, c.req.param("id"));
    const publiclyVisible = sqlite.prepare(`SELECT 1 FROM occurrences
      WHERE id = ? AND visibility = 'PUBLISHED' AND fulfillment_status = 'SCHEDULED'`).get(occurrence.id) !== undefined;
    const inTour = sqlite.prepare("SELECT 1 FROM occurrences WHERE id = ? AND visibility = 'PUBLISHED'").get(occurrence.id) !== undefined;
    return c.json({ occurrence, publicly_visible: publiclyVisible, in_tour: inTour });
  });

  router.get("/run/:runId/orders", (c) => {
    const statusId = c.req.query("status_id") ?? "";
    const rows = sqlite.prepare("SELECT id FROM orders WHERE public_status_id = ? AND certification_run_id = ?")
      .all(statusId, c.req.param("runId")) as { id: string }[];
    return c.json({ order_ids: rows.map((row) => row.id) });
  });

  router.get("/run/:runId/order/:orderId/evidence", (c) => {
    runOrder(sqlite, c.req.param("runId"), c.req.param("orderId"));
    return c.json(domain.orderEvidence(c.req.param("orderId")));
  });

  /**
   * The cancellation a certification performs on its own booking, as an
   * ordinary customer-initiated one. The booking has to belong to this run's
   * order: a credential that could cancel any booking would be an admin
   * credential with extra steps.
   */
  router.post("/run/:runId/cancel-booking", async (c) => {
    const body = (await c.req.json()) as { booking_id?: unknown; idempotency_key?: unknown; reason?: unknown };
    const bookingId = String(body.booking_id ?? "");
    const idempotencyKey = String(body.idempotency_key ?? "");
    if (!bookingId || !idempotencyKey) throw new CertificationEndpointError("CERTIFICATION_CANCELLATION_REQUEST_INVALID", 422);
    const booking = sqlite.prepare("SELECT order_id FROM bookings WHERE id = ?").get(bookingId) as { order_id: string } | undefined;
    if (!booking) throw new DomainError("BOOKING_NOT_FOUND", 404);
    runOrder(sqlite, c.req.param("runId"), booking.order_id);
    // A full cancellation, with nothing withheld: a certification that kept
    // part of its own rouble would be proving a refund it did not make.
    return c.json(domain.cancelCustomerBooking(bookingId, {
      reason: String(body.reason ?? "Production E2E certification"),
      confirmation_text: CERTIFICATION_CANCELLATION_CONFIRMATION,
    }, idempotencyKey));
  });

  return router;
};
