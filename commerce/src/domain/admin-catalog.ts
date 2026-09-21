import type Database from "better-sqlite3";
import { id, now } from "../crypto";
import { findCityBySlug } from "../../../lib/city-catalog";
import { DomainError, many, one, type Row } from "./shared";

interface AdminCatalogHost {
  readonly db: Database.Database;
  withAdminCommand<T extends Row>(command: string, idempotencyKey: string, payload: unknown, table: "cities", operation: () => T): T;
  recordAdminCommandAudit(adminId: string, action: string, entityType: string, entityId: string, auditContext: string | undefined, idempotencyKey: string, payload: unknown): void;
  agentAgreementProjection(agentId: string): Row | null;
}

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

export const createAgent = (host: AdminCatalogHost, input: Record<string, unknown>) => {
  const agentId = id();
  host.db.prepare(`INSERT INTO partners(id, slug, display_name, email, enabled)
    VALUES (?, ?, ?, ?, ?)`)
    .run(agentId, input.slug, input.display_name, String(input.email).toLowerCase(), input.enabled === false ? 0 : 1);
  return one(host.db, "SELECT * FROM partners WHERE id = ?", agentId)!;
};

export const agentList = (host: AdminCatalogHost) =>
  many(host.db, `SELECT a.id, a.slug, a.display_name, a.email, a.enabled, a.created_at, a.updated_at,
      COUNT(p.id) AS promo_count,
      lp.id AS lp_id, lp.revision AS lp_revision, lp.legal_form AS lp_legal_form, lp.tax_mode AS lp_tax_mode,
      lp.projected_contractor_type AS lp_projected_contractor_type, lp.opf AS lp_opf, lp.full_name AS lp_full_name,
      lp.short_name AS lp_short_name, lp.inn AS lp_inn, lp.kpp AS lp_kpp,
      lp.registration_number AS lp_registration_number, lp.legal_address AS lp_legal_address
    FROM partners a
    LEFT JOIN promo_codes p ON p.agent_id = a.id
    LEFT JOIN agent_referrals_legal_profile_revisions lp ON lp.agent_id = a.id
      AND lp.revision = (SELECT MAX(revision) FROM agent_referrals_legal_profile_revisions WHERE agent_id = a.id)
    GROUP BY a.id ORDER BY a.created_at DESC, a.id DESC`)
    .map(({
      lp_id, lp_revision, lp_legal_form, lp_tax_mode, lp_projected_contractor_type, lp_opf, lp_full_name,
      lp_short_name, lp_inn, lp_kpp, lp_registration_number, lp_legal_address, ...agent
    }): Row => ({
      ...agent,
      legal_profile: lp_id
        ? {
          id: lp_id, revision: lp_revision, legal_form: lp_legal_form, tax_mode: lp_tax_mode,
          projected_contractor_type: lp_projected_contractor_type, opf: lp_opf, full_name: lp_full_name,
          short_name: lp_short_name, inn: lp_inn, kpp: lp_kpp,
          registration_number: lp_registration_number, legal_address: lp_legal_address,
        }
        : null,
      agreement: host.agentAgreementProjection(String(agent.id)),
    }));

export const patchAgent = (host: AdminCatalogHost, agentId: string, input: Record<string, unknown>) => {
  const existing = one(host.db, "SELECT * FROM partners WHERE id = ?", agentId);
  if (!existing) throw new DomainError("AGENT_NOT_FOUND", 404);
  const allowed = ["display_name", "email", "enabled"];
  const fields = allowed.filter((field) => input[field] !== undefined);
  if (!fields.length) return existing;
  host.db.prepare(`UPDATE partners SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...fields.map((field) => field === "enabled" ? Number(input[field]) : field === "email" ? String(input[field]).toLowerCase() : input[field]), now(), agentId);
  return one(host.db, "SELECT * FROM partners WHERE id = ?", agentId)!;
};

export const createPromo = (host: AdminCatalogHost, input: Record<string, unknown>, promoId: string = id()) => {
  if (input.agent_id && !one(host.db, "SELECT id FROM partners WHERE id = ?", input.agent_id)) throw new DomainError("AGENT_NOT_FOUND", 404);
  const normalized = String(input.code).trim().toUpperCase();
  host.db.prepare("INSERT INTO promo_codes(id, agent_id, code, normalized_code, status, discount_type, discount_value) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(promoId, input.agent_id ?? null, normalized, normalized, input.status ?? "ACTIVE", input.discount_type, input.discount_value);
  return one(host.db, "SELECT * FROM promo_codes WHERE id = ?", promoId)!;
};

export const promoList = (host: AdminCatalogHost) =>
  many(host.db, `SELECT p.*, a.id AS agent_id, a.slug AS agent_slug, a.display_name AS agent_display_name, a.enabled AS agent_enabled
    FROM promo_codes p LEFT JOIN partners a ON a.id = p.agent_id ORDER BY p.created_at DESC, p.id DESC`)
    .map((promo) => ({ ...promo, agent: promo.agent_id ? { id: promo.agent_id, slug: promo.agent_slug, display_name: promo.agent_display_name, enabled: promo.agent_enabled } : null }));

export const patchPromo = (host: AdminCatalogHost, promoId: string, input: Record<string, unknown>) => {
  const existing = one(host.db, "SELECT * FROM promo_codes WHERE id = ?", promoId);
  if (!existing) throw new DomainError("PROMO_NOT_FOUND", 404);
  if (input.agent_id && !one(host.db, "SELECT id FROM partners WHERE id = ?", input.agent_id)) throw new DomainError("AGENT_NOT_FOUND", 404);
  const allowed = ["agent_id", "status", "discount_type", "discount_value"];
  const fields = allowed.filter((field) => input[field] !== undefined);
  if (!fields.length) return existing;
  host.db.prepare(`UPDATE promo_codes SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...fields.map((field) => input[field]), now(), promoId);
  return one(host.db, "SELECT * FROM promo_codes WHERE id = ?", promoId)!;
};
