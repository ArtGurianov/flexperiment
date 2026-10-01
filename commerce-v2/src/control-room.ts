import type Database from "better-sqlite3";
import type {
  AttentionResponse,
  AuditResponse,
  CatalogueResponse,
  CitiesResponse,
  ControlRoomIntegrationSummary,
  CustomersResponse,
  EntitlementsResponse,
  EmailOperationsResponse,
  IncidentsResponse,
  LabOccurrencesResponse,
  OrdersResponse,
} from "@flexperiment/control-room-contracts";
import type { CommerceRuntimeConfig } from "./payment-mode";
import { playbackAccessSummary } from "./playback-telemetry";

export function controlRoomCatalogue(db: Database.Database, now = new Date().toISOString()): CatalogueResponse {
  const rows = db.prepare(`SELECT product.product_ref,product.course_ref,product.access_model,product.withdrawn_at,product.version AS product_version,
      product.withdrawn_reason,product.withdrawn_terms_ref,offer.offer_ref,offer.price_kopecks,offer.sale_mode,
      offer.acceptance_allowlist_json,projection.version AS projection_version,projection.visibility,projection.last_reconciled_at
    FROM products product
    LEFT JOIN offers offer ON offer.product_id=product.id
    LEFT JOIN catalog_course_projection projection ON projection.course_ref=product.course_ref
    WHERE product.kind='ONLINE_COURSE' ORDER BY product.course_ref`).all() as Array<{
      product_ref: string; course_ref: string; access_model: "FREE" | "PAID"; withdrawn_at: string | null; product_version: number;
      withdrawn_reason: string | null; withdrawn_terms_ref: string | null; offer_ref: string | null;
      price_kopecks: number | null; sale_mode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC" | null;
      acceptance_allowlist_json: string | null; projection_version: number | null; visibility: "LISTED" | "UNLISTED" | null;
      last_reconciled_at: string | null;
    }>;
  return { generatedAt: now, courses: rows.map((row) => ({
    courseRef: row.course_ref,
    productRef: row.product_ref,
    accessModel: row.access_model,
    withdrawn: row.withdrawn_at !== null,
    withdrawnReason: row.withdrawn_reason,
    withdrawnTermsRef: row.withdrawn_terms_ref,
    version: row.product_version,
    offer: row.offer_ref && row.price_kopecks !== null && row.sale_mode ? {
      offerRef: row.offer_ref,
      priceKopecks: row.price_kopecks,
      saleMode: row.sale_mode,
      acceptanceAllowlist: JSON.parse(row.acceptance_allowlist_json ?? "[]") as string[],
    } : null,
    projection: row.projection_version !== null && row.visibility && row.last_reconciled_at ? {
      version: row.projection_version,
      visibility: row.visibility,
      lastReconciledAt: row.last_reconciled_at,
    } : null,
  })) };
}

export function controlRoomOrders(db: Database.Database, now = new Date().toISOString()): OrdersResponse {
  const rows = db.prepare(`SELECT orders.public_id,orders.state,orders.customer_id,customer.email_normalized,product.kind,
      product.product_ref,line.offer_ref_snapshot,line.title_snapshot,line.unit_amount_kopecks,orders.currency,
      attempt.state AS rail_state,attempt.refref_attempt_id,orders.created_at,orders.updated_at
    FROM orders JOIN customers customer ON customer.id=orders.customer_id
    JOIN order_lines line ON line.order_id=orders.id JOIN products product ON product.id=line.product_id
    JOIN checkout_attempts attempt ON attempt.order_id=orders.id ORDER BY orders.created_at DESC`).all() as Array<{
      public_id: string; state: OrdersResponse["orders"][number]["state"]; customer_id: string; email_normalized: string;
      kind: OrdersResponse["orders"][number]["productKind"]; product_ref: string; offer_ref_snapshot: string;
      title_snapshot: string; unit_amount_kopecks: number; currency: "RUB"; rail_state: string;
      refref_attempt_id: string | null; created_at: string; updated_at: string;
    }>;
  return { generatedAt: now, orders: rows.map((row) => ({
    orderPublicId: row.public_id, state: row.state, customerId: row.customer_id, customerEmail: row.email_normalized,
    productKind: row.kind, productRef: row.product_ref, offerRef: row.offer_ref_snapshot, title: row.title_snapshot,
    amountKopecks: row.unit_amount_kopecks, currency: row.currency, railState: row.rail_state,
    refrefAttemptId: row.refref_attempt_id, createdAt: row.created_at, updatedAt: row.updated_at,
  })) };
}

export function controlRoomCustomers(db: Database.Database, now = new Date().toISOString()): CustomersResponse {
  const rows = db.prepare(`SELECT customer.id,customer.email_normalized,customer.display_name,customer.auth_user_id,customer.created_at,
      (SELECT COUNT(*) FROM orders WHERE orders.customer_id=customer.id) AS order_count,
      (SELECT COUNT(*) FROM course_entitlements entitlement WHERE entitlement.customer_id=customer.id AND entitlement.revoked_at IS NULL) AS active_entitlement_count
    FROM customers customer ORDER BY customer.created_at DESC`).all() as Array<{
      id: string; email_normalized: string; display_name: string | null; auth_user_id: string | null; created_at: string;
      order_count: number; active_entitlement_count: number;
    }>;
  return { generatedAt: now, customers: rows.map((row) => ({
    customerId: row.id, email: row.email_normalized, displayName: row.display_name, authBound: row.auth_user_id !== null,
    orderCount: row.order_count, activeEntitlementCount: row.active_entitlement_count, createdAt: row.created_at,
  })) };
}

export function controlRoomEntitlements(db: Database.Database, now = new Date().toISOString()): EntitlementsResponse {
  const rows = db.prepare(`SELECT entitlement.id,entitlement.customer_id,customer.email_normalized,entitlement.scope,
      entitlement.course_ref,orders.public_id,json_extract(orders.checkout_snapshot_json,'$.schema') AS source_schema,
      entitlement.granted_at,entitlement.revoked_at,entitlement.revocation_reason
    FROM course_entitlements entitlement JOIN customers customer ON customer.id=entitlement.customer_id
    JOIN order_lines line ON line.id=entitlement.source_order_line_id JOIN orders ON orders.id=line.order_id
    ORDER BY entitlement.granted_at DESC`).all() as Array<{
      id: string; customer_id: string; email_normalized: string; scope: "COURSE" | "ALL_COURSES"; course_ref: string | null;
      public_id: string; source_schema: string | null; granted_at: string; revoked_at: string | null; revocation_reason: string | null;
    }>;
  return { generatedAt: now, entitlements: rows.map((row) => ({
    entitlementId: row.id, customerId: row.customer_id, customerEmail: row.email_normalized, scope: row.scope,
    courseRef: row.course_ref, sourceOrderPublicId: row.public_id,
    sourceKind: row.source_schema === "flexperiment.manual-entitlement/1" ? "MANUAL" : "PURCHASE",
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at, revocationReason: row.revocation_reason,
  })) };
}

export function controlRoomCities(db: Database.Database, now = new Date().toISOString()): CitiesResponse {
  const rows = db.prepare(`SELECT city.id,city.slug,city.title,
      (SELECT COUNT(*) FROM lab_occurrences occurrence WHERE occurrence.city_id=city.id) AS occurrence_count
    FROM cities city ORDER BY city.title`).all() as Array<{ id: string; slug: string; title: string; occurrence_count: number }>;
  return { generatedAt: now, cities: rows.map((row) => ({
    cityId: row.id, slug: row.slug, title: row.title, occurrenceCount: row.occurrence_count,
  })) };
}

export function controlRoomLabOccurrences(db: Database.Database, now = new Date().toISOString()): LabOccurrencesResponse {
  const rows = db.prepare(`SELECT occurrence.occurrence_ref,occurrence.city_id,city.title AS city_title,occurrence.title,
      occurrence.starts_at,occurrence.ends_at,occurrence.timezone,occurrence.capacity,occurrence.sales_status
    FROM lab_occurrences occurrence JOIN cities city ON city.id=occurrence.city_id ORDER BY occurrence.starts_at`)
    .all() as Array<{ occurrence_ref: string; city_id: string; city_title: string; title: string; starts_at: string;
      ends_at: string; timezone: string; capacity: number; sales_status: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC" }>;
  return { generatedAt: now, occurrences: rows.map((row) => ({
    occurrenceRef: row.occurrence_ref, cityId: row.city_id, cityTitle: row.city_title, title: row.title,
    startsAt: row.starts_at, endsAt: row.ends_at, timezone: row.timezone, capacity: row.capacity, salesStatus: row.sales_status,
  })) };
}

export function controlRoomAttention(db: Database.Database, now = new Date().toISOString()): AttentionResponse {
  const rows = db.prepare(`SELECT operation_id,course_ref,scope_level,scope_ref,state,attention_reason,orphaned_at,created_at,deadline_at
    FROM access_overrides WHERE attention_reason IS NOT NULL ORDER BY created_at`).all() as Array<{
      operation_id: string; course_ref: string; scope_level: "COURSE" | "SECTION" | "LESSON";
      scope_ref: string; state: AttentionResponse["items"][number]["state"]; attention_reason: string;
      orphaned_at: string | null; created_at: string; deadline_at: string;
    }>;
  return { generatedAt: now, items: rows.map((row) => ({
    operationId: row.operation_id, courseRef: row.course_ref, scopeLevel: row.scope_level, scopeRef: row.scope_ref,
    state: row.state, attentionReason: row.attention_reason, orphanedAt: row.orphaned_at,
    createdAt: row.created_at, deadlineAt: row.deadline_at,
  })) };
}

export function controlRoomIntegrationSummary(
  db: Database.Database,
  config: CommerceRuntimeConfig,
  now = new Date(),
  leaseMs = 24 * 60 * 60 * 1000,
): ControlRoomIntegrationSummary {
  const last = db.prepare(`SELECT orders.public_id,attempt.refref_attempt_id,attempt.updated_at
    FROM checkout_attempts attempt JOIN orders ON orders.id=attempt.order_id
    WHERE attempt.state IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND attempt.refref_attempt_id IS NOT NULL
    ORDER BY attempt.updated_at DESC LIMIT 1`).get() as { public_id: string; refref_attempt_id: string; updated_at: string } | undefined;
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
  return {
    paymentMode: config.paymentMode,
    lastAcceptedPayment: last ? { orderPublicId: last.public_id, observedAt: last.updated_at, refrefAttemptId: last.refref_attempt_id } : null,
    outstandingCheckoutCount: count("SELECT COUNT(*) AS count FROM checkout_attempts WHERE state IN ('CREATING','CREATE_UNKNOWN','PENDING','CUSTOMER_ACTION_REQUIRED')"),
    processingRefundCount: count("SELECT COUNT(*) AS count FROM refund_executions WHERE state IN ('READY','PROCESSING')"),
    attentionOverrideCount: count("SELECT COUNT(*) AS count FROM access_overrides WHERE attention_reason IS NOT NULL"),
    staleProjectionCount: count("SELECT COUNT(*) AS count FROM catalog_course_projection WHERE last_reconciled_at < ?", new Date(now.getTime() - leaseMs).toISOString()),
    playbackAccess24h: playbackAccessSummary(db, new Date(now.getTime() - 24 * 60 * 60_000).toISOString()),
  };
}

export function controlRoomEmailOperations(db: Database.Database, now = new Date().toISOString()): EmailOperationsResponse {
  const authEmails = db.prepare(`SELECT id,recipient_normalized AS recipient,state,attempt_count AS attemptCount,
    last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
    FROM auth_email_outbox ORDER BY created_at DESC LIMIT 250`).all() as EmailOperationsResponse["authEmails"];
  const campaigns = db.prepare(`SELECT campaign.id,campaign.course_ref AS courseRef,campaign.state,campaign.confirmed_by AS confirmedBy,
      campaign.confirmed_at AS confirmedAt,campaign.created_at AS createdAt,
      COUNT(recipient.id) AS recipientCount,
      COALESCE(SUM(recipient.state='SENT'),0) AS sentCount,
      COALESCE(SUM(recipient.state='FAILED'),0) AS failedCount,
      COALESCE(SUM(recipient.state IN ('SKIPPED_NO_CONSENT','SKIPPED_SUPPRESSED')),0) AS skippedCount
    FROM notification_campaigns campaign LEFT JOIN notification_campaign_recipients recipient ON recipient.campaign_id=campaign.id
    GROUP BY campaign.id ORDER BY campaign.created_at DESC LIMIT 250`).all() as EmailOperationsResponse["campaigns"];
  return { generatedAt: now, authEmails, campaigns };
}

export function controlRoomIncidents(db: Database.Database, now = new Date().toISOString()): IncidentsResponse {
  const incidents: IncidentsResponse["incidents"] = [];
  const push = (kind: IncidentsResponse["incidents"][number]["kind"], rows: Array<{ id: string; subject: string; code: string; observed: string }>, severity: "ATTENTION" | "FAILED" | "UNKNOWN") => {
    for (const row of rows) incidents.push({ incidentRef: `${kind}:${row.id}`, kind, severity, subjectRef: row.subject, code: row.code, observedAt: row.observed });
  };
  push("ACCESS_OVERRIDE", db.prepare(`SELECT operation_id AS id,scope_ref AS subject,attention_reason AS code,
    COALESCE(orphaned_at,created_at) AS observed FROM access_overrides WHERE attention_reason IS NOT NULL`).all() as Array<{ id: string; subject: string; code: string; observed: string }>, "ATTENTION");
  push("CHECKOUT", db.prepare(`SELECT id,order_id AS subject,state AS code,updated_at AS observed FROM checkout_attempts
    WHERE state IN ('CREATE_UNKNOWN','REVIEW_REQUIRED')`).all() as Array<{ id: string; subject: string; code: string; observed: string }>, "UNKNOWN");
  push("REFUND", db.prepare(`SELECT id,refund_request_id AS subject,COALESCE(last_error_code,state) AS code,updated_at AS observed
    FROM refund_executions WHERE state='REVIEW_REQUIRED'`).all() as Array<{ id: string; subject: string; code: string; observed: string }>, "UNKNOWN");
  push("AUTH_EMAIL", db.prepare(`SELECT id,recipient_normalized AS subject,COALESCE(last_error,'EMAIL_FAILED') AS code,updated_at AS observed
    FROM auth_email_outbox WHERE state='FAILED'`).all() as Array<{ id: string; subject: string; code: string; observed: string }>, "FAILED");
  push("CAMPAIGN", db.prepare(`SELECT id,course_ref AS subject,state AS code,created_at AS observed
    FROM notification_campaigns WHERE state='FAILED'`).all() as Array<{ id: string; subject: string; code: string; observed: string }>, "FAILED");
  incidents.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  return { generatedAt: now, incidents };
}

export function controlRoomAudit(db: Database.Database, now = new Date().toISOString()): AuditResponse {
  const merchant = db.prepare(`SELECT id,'MERCHANT' AS source,actor,action,subject_type AS entityType,subject_ref AS entityId,
    evidence_json AS detailsJson,created_at AS createdAt FROM audit_log`).all() as Array<Omit<AuditResponse["entries"][number], "details"> & { detailsJson: string }>;
  const control = db.prepare(`SELECT id,'CONTROL_ROOM' AS source,admin_id AS actor,action,entity_type AS entityType,entity_id AS entityId,
    details_json AS detailsJson,created_at AS createdAt FROM control_room_audit_log`).all() as Array<Omit<AuditResponse["entries"][number], "details"> & { detailsJson: string }>;
  return { generatedAt: now, entries: [...merchant, ...control]
    .map(({ detailsJson, ...entry }) => ({ ...entry, details: JSON.parse(detailsJson) as Record<string, unknown> }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 250) };
}
