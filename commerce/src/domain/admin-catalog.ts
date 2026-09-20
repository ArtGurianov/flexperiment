import { id } from "../crypto";
import { findCityBySlug } from "../../../lib/city-catalog";
import { DomainError, one } from "../domain";

type AdminCatalogHost = any;

export const createCity = (host: AdminCatalogHost, input: { city_slug: string; audit_context?: string }, idempotencyKey: string, adminId: string) =>
  host.withAdminCommand("city-create", idempotencyKey, input, "cities", () => {
    const canonicalCity = findCityBySlug(input.city_slug);
    if (!canonicalCity) throw new DomainError("CITY_SLUG_UNKNOWN", 400);
    if (one(host.db, "SELECT id FROM cities WHERE slug = ?", canonicalCity.slug)) throw new DomainError("CITY_SLUG_CONFLICT", 409);
    const cityId = id();
    host.db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)").run(cityId, canonicalCity.slug, canonicalCity.title);
    const city = one(host.db, "SELECT * FROM cities WHERE id = ?", cityId)!;
    host.recordAdminCommandAudit(adminId, "CITY_CREATED", "city", cityId, input.audit_context, idempotencyKey, input);
    return city;
  });

export const patchCity = (host: AdminCatalogHost, cityId: string, input: { city_slug: string; audit_context?: string }, idempotencyKey: string, adminId: string) => {
  const payload = { city_id: cityId, ...input };
  return host.withAdminCommand("city-patch", idempotencyKey, payload, "cities", () => {
    const before = one(host.db, "SELECT * FROM cities WHERE id = ?", cityId);
    if (!before) throw new DomainError("CITY_NOT_FOUND", 404);
    const canonicalCity = findCityBySlug(input.city_slug);
    if (!canonicalCity) throw new DomainError("CITY_SLUG_UNKNOWN", 400);
    const slugChanges = before.slug !== canonicalCity.slug;
    const titleChanges = before.title !== canonicalCity.title;
    if (!slugChanges && !titleChanges) return before;
    if (slugChanges && Number(one(host.db, "SELECT COUNT(*) AS count FROM occurrences WHERE city_id = ?", cityId)?.count ?? 0) > 0) throw new DomainError("CITY_HAS_OCCURRENCES", 409);
    if (one(host.db, "SELECT id FROM cities WHERE slug = ? AND id <> ?", canonicalCity.slug, cityId)) throw new DomainError("CITY_SLUG_CONFLICT", 409);
    host.db.prepare("UPDATE cities SET slug = ?, title = ? WHERE id = ?").run(canonicalCity.slug, canonicalCity.title, cityId);
    const city = one(host.db, "SELECT * FROM cities WHERE id = ?", cityId)!;
    host.recordAdminCommandAudit(adminId, "CITY_EDITED", "city", cityId, input.audit_context, idempotencyKey, payload);
    return city;
  });
};
