import { emailHash, id } from "../crypto";
import { findCityBySlug } from "../../../lib/city-catalog";
import { CITY_INTEREST_SWEEP_BATCH_SIZE, DomainError, legalManifest, many, one, withImmediateTransaction } from "../domain";

type CityInterestHost = any;

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

    if (existing && host.canRenewCityInterestNotification(String(existing.id))) {
      const replacementId = id();
      host.db.prepare(`UPDATE city_interest_notification_intents
        SET superseded_at = ?
        WHERE city_interest_request_id = ? AND superseded_at IS NULL`).run(timestamp, existing.id);
      host.db.prepare(`UPDATE city_interest_requests
        SET email_normalized = '', email_hash = '', superseded_at = ?,
            superseded_by_request_id = ?
        WHERE id = ? AND superseded_at IS NULL`).run(timestamp, replacementId, existing.id);
      host.insertCityInterestRequest({
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
      host.insertCityInterestRequest({
        requestId: id(), email: input.email, emailHash: normalizedEmailHash,
        citySlug: city.slug, manifest, timestamp, expiresAt,
      });
    }
    host.consumeEligibleCityInterests(city.slug, CITY_INTEREST_SWEEP_BATCH_SIZE);
    return { accepted: true };
  });

export const processCityInterestLifecycle = (host: CityInterestHost) =>
  withImmediateTransaction(host.db, () => {
    const timestamp = new Date(host.clock()).toISOString();
    const expired = many(host.db, `SELECT id FROM city_interest_requests
      WHERE superseded_at IS NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`, timestamp, CITY_INTEREST_SWEEP_BATCH_SIZE);
    for (const row of expired) host.purgeCityInterestRequest(String(row.id));
    const intentsCreated = host.consumeEligibleCityInterests(undefined, CITY_INTEREST_SWEEP_BATCH_SIZE, timestamp);
    return { expired_deleted: expired.length, intents_created: intentsCreated };
  });

const cityInterestExpiry = (timestamp: string) => {
  const date = new Date(timestamp);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
};
