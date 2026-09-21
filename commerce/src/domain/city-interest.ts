import type Database from "better-sqlite3";
import { emailHash, id, now } from "../crypto";
import { findCityBySlug } from "../../../lib/city-catalog";
import { availableSeatsSql } from "../occurrence-inventory";
import { purchaseStatus } from "../purchase-status";
import { suppressMessageDispatch } from "../outbox-attempt-store";
import { parseUtcTimestamp } from "../utc-timestamp";
import type { LegalManifest } from "../legal-manifest";
import { CITY_INTEREST_SWEEP_BATCH_SIZE, DomainError, legalManifest, many, one, withImmediateTransaction } from "./shared";

type CityInterestRequestInput = {
  requestId: string;
  email: string;
  emailHash: string;
  citySlug: string;
  manifest: LegalManifest;
  timestamp: string;
  expiresAt: string;
};

interface CityInterestHost {
  readonly db: Database.Database;
  readonly clock: () => number;
  atomically<T>(operation: () => T): T;
  enqueueEmail(type: string, recipientEmail: string, recipientEmailHash: string, template: string, payloadRef: string, payload: Record<string, unknown>): string;
  newOrdersBlocked(): boolean;
  occurrenceNotificationsAvailable(): boolean;
}

export const registerCityInterest = (host: CityInterestHost, input: { email: string; city: string }) =>
  withImmediateTransaction(host.db, () => {
    const city = findCityBySlug(input.city);
    if (!city) throw new DomainError("CITY_SLUG_UNKNOWN", 400);
    const release = one(host.db, "SELECT manifest_json FROM legal_releases WHERE active = 1");
    if (!release) throw new DomainError("LEGAL_RELEASE_NOT_ACTIVE", 503);
    const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
    const timestamp = new Date(host.clock()).toISOString();
    const expiresAt = cityInterestExpiry(timestamp);
    const normalizedEmailHash = emailHash(input.email);
    const existing = one(host.db, `SELECT id FROM city_interest_requests
      WHERE email_hash = ? AND city_slug = ? AND superseded_at IS NULL`, normalizedEmailHash, city.slug);

    if (existing && canRenewCityInterestNotification(host, String(existing.id))) {
      const replacementId = id();
      host.db.prepare(`UPDATE city_interest_notification_intents
        SET superseded_at = ?
        WHERE city_interest_request_id = ? AND superseded_at IS NULL`).run(timestamp, existing.id);
      host.db.prepare(`UPDATE city_interest_requests
        SET email_normalized = '', email_hash = '', superseded_at = ?,
            superseded_by_request_id = ?
        WHERE id = ? AND superseded_at IS NULL`).run(timestamp, replacementId, existing.id);
      insertCityInterestRequest(host, {
        requestId: replacementId, email: input.email, emailHash: normalizedEmailHash,
        citySlug: city.slug, manifest, timestamp, expiresAt,
      });
    } else if (existing) {
      host.db.prepare(`UPDATE city_interest_requests
        SET email_normalized = ?, privacy_policy_version = ?,
            privacy_policy_sha256 = ?, pd_consent_version = ?,
            pd_consent_sha256 = ?, consent_accepted_at = ?, created_at = ?,
            expires_at = ?
        WHERE id = ? AND superseded_at IS NULL`).run(
        input.email, manifest.documents.PRIVACY_POLICY.version, manifest.documents.PRIVACY_POLICY.sha256,
        manifest.documents.PD_CONSENT.version, manifest.documents.PD_CONSENT.sha256,
        timestamp, timestamp, expiresAt, existing.id,
      );
    } else {
      insertCityInterestRequest(host, {
        requestId: id(), email: input.email, emailHash: normalizedEmailHash,
        citySlug: city.slug, manifest, timestamp, expiresAt,
      });
    }
    consumeEligibleCityInterests(host, city.slug, CITY_INTEREST_SWEEP_BATCH_SIZE);
    return { accepted: true };
  });

export const processCityInterestLifecycle = (host: CityInterestHost) =>
  withImmediateTransaction(host.db, () => {
    const timestamp = new Date(host.clock()).toISOString();
    const expired = many(host.db, `SELECT id FROM city_interest_requests
      WHERE superseded_at IS NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`, timestamp, CITY_INTEREST_SWEEP_BATCH_SIZE);
    for (const row of expired) purgeCityInterestRequest(host, String(row.id));
    const intentsCreated = consumeEligibleCityInterests(host, undefined, CITY_INTEREST_SWEEP_BATCH_SIZE, timestamp);
    return { expired_deleted: expired.length, intents_created: intentsCreated };
  });

const cityInterestExpiry = (timestamp: string) => {
  const date = new Date(timestamp);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
};

export const insertCityInterestRequest = (host: CityInterestHost, input: CityInterestRequestInput) => {
  host.db.prepare(`INSERT INTO city_interest_requests(
    id, email_normalized, email_hash, city_slug,
    privacy_policy_version, privacy_policy_sha256,
    pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at,
    expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.requestId, input.email, input.emailHash, input.citySlug,
    input.manifest.documents.PRIVACY_POLICY.version, input.manifest.documents.PRIVACY_POLICY.sha256,
    input.manifest.documents.PD_CONSENT.version, input.manifest.documents.PD_CONSENT.sha256,
    input.timestamp, input.timestamp, input.expiresAt,
  );
};

export const consumeEligibleCityInterests = (host: CityInterestHost, citySlug?: string, limit = CITY_INTEREST_SWEEP_BATCH_SIZE, timestamp = new Date(host.clock()).toISOString()) => {
  const interests = many(host.db, `SELECT ci.id, ci.email_normalized, ci.email_hash, ci.city_slug,
      c.title AS city_title, o.id AS occurrence_id, o.title AS occurrence_title, o.starts_at
    FROM city_interest_requests ci
    JOIN cities c ON c.slug = ci.city_slug
    JOIN occurrences o ON o.id = (
      SELECT candidate.id FROM occurrences candidate
      WHERE candidate.city_id = c.id
        AND candidate.visibility = 'PUBLISHED'
        AND candidate.fulfillment_status = 'SCHEDULED'
        AND candidate.starts_at >= ?
      ORDER BY candidate.starts_at, candidate.id
      LIMIT 1
    )
    WHERE ci.superseded_at IS NULL
      AND ci.expires_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM city_interest_notification_intents intent
        WHERE intent.city_interest_request_id = ci.id
          AND intent.superseded_at IS NULL
      ) ${citySlug ? "AND ci.city_slug = ?" : ""}
    ORDER BY ci.created_at, ci.id
    LIMIT ?`, timestamp, timestamp, ...(citySlug ? [citySlug] : []), limit);
  for (const interest of interests) {
    const outboxId = host.enqueueEmail("CITY_INTEREST_AVAILABLE", String(interest.email_normalized), String(interest.email_hash), "city-interest-available", `city-interest:${interest.id}`, {
      city_title: interest.city_title,
      occurrence_id: interest.occurrence_id,
      occurrence_title: interest.occurrence_title,
      starts_at: interest.starts_at,
    });
    host.db.prepare("INSERT INTO city_interest_notification_intents(id, city_interest_request_id, outbox_id) VALUES (?, ?, ?)").run(outboxId, interest.id, outboxId);
  }
  return interests.length;
};

export const isActiveCityInterestNotification = (host: CityInterestHost, outboxId: string) => Boolean(one(host.db, `SELECT request.id
  FROM city_interest_notification_intents intent
  JOIN city_interest_requests request ON request.id = intent.city_interest_request_id
  WHERE intent.outbox_id = ?
    AND intent.superseded_at IS NULL
    AND request.superseded_at IS NULL
    AND request.expires_at > ?`, outboxId, new Date(host.clock()).toISOString()));

export const canRenewCityInterestNotification = (host: CityInterestHost, requestId: string) => {
  const current = one(host.db, `SELECT outbox.status,
      EXISTS(SELECT 1 FROM email_provider_events
        WHERE outbox_id = outbox.id AND provider_status = 'hard_bounced') AS has_hard_bounced,
      EXISTS(SELECT 1 FROM email_provider_events
        WHERE outbox_id = outbox.id AND provider_status = 'delivered') AS has_delivered
    FROM city_interest_notification_intents intent
    JOIN email_outbox outbox ON outbox.id = intent.outbox_id
    WHERE intent.city_interest_request_id = ? AND intent.superseded_at IS NULL`, requestId);
  return current?.status === "FAILED"
    || (Boolean(current?.has_hard_bounced) && !Boolean(current?.has_delivered));
};

export const suppressCityInterestOutbox = (host: CityInterestHost, outboxId: string) => {
  host.atomically(() =>
    suppressMessageDispatch(host.db, outboxId, "CITY_INTEREST_AVAILABLE", "CITY_INTEREST_NO_LONGER_ACTIVE", now()));
};

export const purgeCityInterestRequest = (host: CityInterestHost, requestId: string) => {
  const outboxes = many(host.db, `SELECT intent.outbox_id
    FROM city_interest_notification_intents intent
    WHERE intent.city_interest_request_id = ?`, requestId);
  for (const outbox of outboxes) suppressCityInterestOutbox(host, String(outbox.outbox_id));
  host.db.prepare("DELETE FROM city_interest_requests WHERE id = ?").run(requestId);
};

type OccurrenceNotificationRequestInput = {
  requestId: string;
  email: string;
  emailHash: string;
  occurrenceId: string;
  manifest: LegalManifest;
  timestamp: string;
};

export const registerOccurrenceNotification = (host: CityInterestHost, input: { email: string; occurrence_id: string }) =>
  withImmediateTransaction(host.db, () => {
    if (!host.occurrenceNotificationsAvailable()) throw new DomainError("NOTIFICATIONS_NOT_AVAILABLE", 503);
    const occurrence = one(host.db, `SELECT o.*, ${availableSeatsSql("o")} AS availability
      FROM occurrences o WHERE o.id = ? AND o.visibility = 'PUBLISHED'`, input.occurrence_id);
    if (!occurrence || occurrence.fulfillment_status !== "SCHEDULED" || parseUtcTimestamp(String(occurrence.starts_at)) <= host.clock()) {
      throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    }
    const status = purchaseStatus({
      salesStatus: occurrence.sales_status === "PAUSED" ? "PAUSED" : occurrence.sales_status === "CLOSED" ? "CLOSED" : "OPEN",
      fulfillmentStatus: "SCHEDULED", startsAtMs: parseUtcTimestamp(String(occurrence.starts_at)), nowMs: host.clock(),
      availability: Number(occurrence.availability), newOrdersBlocked: host.newOrdersBlocked(),
    });
    if (status === "AVAILABLE") throw new DomainError("OCCURRENCE_ALREADY_AVAILABLE", 409);
    const release = one(host.db, "SELECT manifest_json FROM legal_releases WHERE active = 1");
    if (!release) throw new DomainError("LEGAL_RELEASE_NOT_ACTIVE", 503);
    const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
    const timestamp = new Date(host.clock()).toISOString();
    const hash = emailHash(input.email);
    const existing = one(host.db, `SELECT id FROM occurrence_notification_requests
      WHERE email_hash = ? AND occurrence_id = ? AND superseded_at IS NULL`, hash, input.occurrence_id);
    if (existing && canRenewOccurrenceNotification(host, String(existing.id))) {
      const replacementId = id();
      host.db.prepare(`UPDATE occurrence_notification_intents SET superseded_at = ?
        WHERE notification_request_id = ? AND superseded_at IS NULL`).run(timestamp, existing.id);
      host.db.prepare(`UPDATE occurrence_notification_requests
        SET email_normalized = '', email_hash = '', superseded_at = ?, superseded_by_request_id = ?
        WHERE id = ? AND superseded_at IS NULL`).run(timestamp, replacementId, existing.id);
      insertOccurrenceNotificationRequest(host, { requestId: replacementId, email: input.email, emailHash: hash, occurrenceId: input.occurrence_id, manifest, timestamp });
    } else if (existing) {
      host.db.prepare(`UPDATE occurrence_notification_requests SET email_normalized = ?, privacy_policy_version = ?,
        privacy_policy_sha256 = ?, pd_consent_version = ?, pd_consent_sha256 = ?, consent_accepted_at = ?, created_at = ?
        WHERE id = ? AND superseded_at IS NULL`).run(input.email,
        manifest.documents.PRIVACY_POLICY.version, manifest.documents.PRIVACY_POLICY.sha256,
        manifest.documents.PD_CONSENT.version, manifest.documents.PD_CONSENT.sha256, timestamp, timestamp, existing.id);
    } else {
      insertOccurrenceNotificationRequest(host, { requestId: id(), email: input.email, emailHash: hash, occurrenceId: input.occurrence_id, manifest, timestamp });
    }
    consumeEligibleOccurrenceNotifications(host, 50);
    return { accepted: true };
  });

export const processOccurrenceNotificationLifecycle = (host: CityInterestHost) =>
  withImmediateTransaction(host.db, () => {
    const timestamp = new Date(host.clock()).toISOString();
    const terminated = many(host.db, `SELECT request.id, o.starts_at, o.fulfillment_status FROM occurrence_notification_requests request
      JOIN occurrences o ON o.id = request.occurrence_id
      WHERE request.superseded_at IS NULL
        AND (o.fulfillment_status = 'CANCELLED' OR julianday(o.starts_at) <= julianday(?))
      ORDER BY request.created_at LIMIT 50`, timestamp)
      .filter((request) => request.fulfillment_status === "CANCELLED" || parseUtcTimestamp(String(request.starts_at)) <= host.clock());
    for (const request of terminated) purgeOccurrenceNotificationRequest(host, String(request.id));
    return { deleted: terminated.length, intents_created: consumeEligibleOccurrenceNotifications(host, 50) };
  });

export const withdrawNotificationConsent = (host: CityInterestHost, email: string, reason: string, adminId: string) =>
  withImmediateTransaction(host.db, () => {
    const requests = many(host.db, "SELECT id FROM city_interest_requests WHERE email_hash = ? AND superseded_at IS NULL", emailHash(email));
    for (const request of requests) purgeCityInterestRequest(host, String(request.id));
    const occurrenceRequests = many(host.db, "SELECT id FROM occurrence_notification_requests WHERE email_hash = ? AND superseded_at IS NULL", emailHash(email));
    for (const request of occurrenceRequests) purgeOccurrenceNotificationRequest(host, String(request.id));
    host.db.prepare("INSERT INTO admin_audit_log(id, admin_id, action, entity_type, entity_id, details_json) VALUES (?, ?, 'NOTIFICATION_CONSENT_WITHDRAWN', 'notification_consent', 'all-matching-requests', ?)")
      .run(id(), adminId, JSON.stringify({ reason, city_interest_deleted: requests.length, occurrence_notification_deleted: occurrenceRequests.length }));
    return { withdrawn: true, city_interest_deleted: requests.length, occurrence_notification_deleted: occurrenceRequests.length };
  });

const insertOccurrenceNotificationRequest = (host: CityInterestHost, input: OccurrenceNotificationRequestInput) => {
  host.db.prepare(`INSERT INTO occurrence_notification_requests(
    id, email_normalized, email_hash, occurrence_id, privacy_policy_version, privacy_policy_sha256,
    pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.requestId, input.email, input.emailHash, input.occurrenceId,
      input.manifest.documents.PRIVACY_POLICY.version, input.manifest.documents.PRIVACY_POLICY.sha256,
      input.manifest.documents.PD_CONSENT.version, input.manifest.documents.PD_CONSENT.sha256, input.timestamp, input.timestamp);
};

const consumeEligibleOccurrenceNotifications = (host: CityInterestHost, limit = 50) => {
  if (!host.occurrenceNotificationsAvailable() || host.newOrdersBlocked()) return 0;
  const timestamp = new Date(host.clock()).toISOString();
  const requests = many(host.db, `SELECT request.id, request.email_normalized, request.email_hash,
    o.id AS occurrence_id, o.title AS occurrence_title, o.starts_at, o.timezone, c.title AS city_title,
    o.sales_status, o.fulfillment_status,
    ${availableSeatsSql("o")} AS availability
    FROM occurrence_notification_requests request
    JOIN occurrences o ON o.id = request.occurrence_id
    JOIN cities c ON c.id = o.city_id
    WHERE request.superseded_at IS NULL
      AND o.sales_status = 'OPEN'
      AND o.fulfillment_status = 'SCHEDULED'
      AND julianday(o.starts_at) > julianday(?)
      AND ${availableSeatsSql("o")} > 0
      AND NOT EXISTS (SELECT 1 FROM occurrence_notification_intents intent
        WHERE intent.notification_request_id = request.id AND intent.superseded_at IS NULL)
    ORDER BY request.created_at, request.id LIMIT ?`, timestamp, limit)
    .filter((request) => purchaseStatus({
      salesStatus: request.sales_status === "PAUSED" ? "PAUSED" : request.sales_status === "CLOSED" ? "CLOSED" : "OPEN",
      fulfillmentStatus: request.fulfillment_status === "COMPLETED" ? "COMPLETED" : request.fulfillment_status === "CANCELLED" ? "CANCELLED" : "SCHEDULED",
      startsAtMs: parseUtcTimestamp(String(request.starts_at)), nowMs: host.clock(), availability: Number(request.availability), newOrdersBlocked: false,
    }) === "AVAILABLE");
  for (const request of requests) {
    const outboxId = host.enqueueEmail("OCCURRENCE_AVAILABLE", String(request.email_normalized), String(request.email_hash), "occurrence-available", `occurrence-notification:${request.id}`, {
      city_title: request.city_title, occurrence_id: request.occurrence_id, occurrence_title: request.occurrence_title, starts_at: request.starts_at, timezone: request.timezone,
    });
    host.db.prepare("INSERT INTO occurrence_notification_intents(id, notification_request_id, outbox_id) VALUES (?, ?, ?)").run(outboxId, request.id, outboxId);
  }
  return requests.length;
};

const canRenewOccurrenceNotification = (host: CityInterestHost, requestId: string) => {
  const current = one(host.db, `SELECT outbox.status,
    EXISTS(SELECT 1 FROM email_provider_events WHERE outbox_id = outbox.id AND provider_status = 'hard_bounced') AS has_hard_bounced,
    EXISTS(SELECT 1 FROM email_provider_events WHERE outbox_id = outbox.id AND provider_status = 'delivered') AS has_delivered
    FROM occurrence_notification_intents intent JOIN email_outbox outbox ON outbox.id = intent.outbox_id
    WHERE intent.notification_request_id = ? AND intent.superseded_at IS NULL`, requestId);
  return current?.status === "FAILED" || (Boolean(current?.has_hard_bounced) && !Boolean(current?.has_delivered));
};

export const isActiveOccurrenceNotification = (host: CityInterestHost, outboxId: string) => {
  const request = one(host.db, `SELECT request.id, o.sales_status, o.fulfillment_status, o.starts_at,
    ${availableSeatsSql("o")} AS availability
    FROM occurrence_notification_intents intent JOIN occurrence_notification_requests request ON request.id = intent.notification_request_id
    JOIN occurrences o ON o.id = request.occurrence_id
    WHERE intent.outbox_id = ? AND intent.superseded_at IS NULL AND request.superseded_at IS NULL`, outboxId);
  if (!request || !host.occurrenceNotificationsAvailable()) return false;
  return purchaseStatus({
    salesStatus: request.sales_status === "PAUSED" ? "PAUSED" : request.sales_status === "CLOSED" ? "CLOSED" : "OPEN",
    fulfillmentStatus: request.fulfillment_status === "COMPLETED" ? "COMPLETED" : request.fulfillment_status === "CANCELLED" ? "CANCELLED" : "SCHEDULED",
    startsAtMs: parseUtcTimestamp(String(request.starts_at)), nowMs: host.clock(), availability: Number(request.availability), newOrdersBlocked: host.newOrdersBlocked(),
  }) === "AVAILABLE";
};

export const suppressOccurrenceNotificationOutbox = (host: CityInterestHost, outboxId: string) => {
  host.atomically(() =>
    suppressMessageDispatch(host.db, outboxId, "OCCURRENCE_AVAILABLE", "OCCURRENCE_NOTIFICATION_NO_LONGER_ACTIVE", now()));
  host.db.prepare("UPDATE occurrence_notification_intents SET superseded_at = COALESCE(superseded_at, ?) WHERE outbox_id = ?").run(now(), outboxId);
};

export const purgeOccurrenceNotificationRequest = (host: CityInterestHost, requestId: string) => {
  const outboxes = many(host.db, "SELECT outbox_id FROM occurrence_notification_intents WHERE notification_request_id = ?", requestId);
  for (const outbox of outboxes) suppressOccurrenceNotificationOutbox(host, String(outbox.outbox_id));
  host.db.prepare("DELETE FROM occurrence_notification_requests WHERE id = ?").run(requestId);
};
