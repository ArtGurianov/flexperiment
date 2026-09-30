import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type MerchantPromotionInput = {
  readonly id?: string;
  readonly code: string;
  readonly discountKind: "FIXED" | "PERCENT_BPS";
  readonly discountValue: number;
  readonly eligibleOfferRef?: string | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly active?: boolean;
  readonly actor: string;
  readonly expectedVersion: number;
};

export type MerchantPromotionSnapshot = {
  readonly id: string;
  readonly code: string;
  readonly discountKind: "FIXED" | "PERCENT_BPS";
  readonly discountValue: number;
  readonly eligibleOfferRef: string | null;
  readonly merchantDiscountKopecks: number;
};

type PromotionRow = {
  id: string;
  code_normalized: string;
  discount_kind: "FIXED" | "PERCENT_BPS";
  discount_value: number;
  eligible_offer_ref: string | null;
  starts_at: string | null;
  ends_at: string | null;
  active: number;
};

export const normalizePromotionCode = (value: string) => value.trim().toUpperCase();

export function normalizeMerchantPromotionPrefix(value: string) {
  const normalized = normalizePromotionCode(value);
  if (!/^[A-Z0-9]{2,16}-$/.test(normalized)) throw new Error("MERCHANT_PROMOTION_PREFIX_INVALID");
  return normalized;
}

const timestamp = (value: string | null | undefined, field: string) => {
  if (!value) return null;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field}_INVALID`);
  return new Date(value).toISOString();
};

const calculateDiscount = (row: PromotionRow, catalogAmountKopecks: number) => {
  const discount = row.discount_kind === "FIXED"
    ? row.discount_value
    : Math.floor(catalogAmountKopecks * row.discount_value / 10_000);
  if (!Number.isSafeInteger(discount) || discount <= 0 || discount >= catalogAmountKopecks) {
    throw new Error("MERCHANT_PROMOTION_DISCOUNT_INVALID");
  }
  return discount;
};

const assertApplicable = (row: PromotionRow, offerRef: string, now: string) => {
  if (!row.active) throw new Error("MERCHANT_PROMOTION_INACTIVE");
  if (row.starts_at && row.starts_at > now) throw new Error("MERCHANT_PROMOTION_NOT_STARTED");
  if (row.ends_at && row.ends_at <= now) throw new Error("MERCHANT_PROMOTION_EXPIRED");
  if (row.eligible_offer_ref && row.eligible_offer_ref !== offerRef) throw new Error("MERCHANT_PROMOTION_NOT_APPLICABLE");
};

export function saveMerchantPromotion(
  db: Database.Database,
  input: MerchantPromotionInput,
  reservedPrefix: string,
  now = new Date().toISOString(),
) {
  const prefix = normalizeMerchantPromotionPrefix(reservedPrefix);
  const code = normalizePromotionCode(input.code);
  if (!code.startsWith(prefix) || code.length <= prefix.length || code.length > 64) throw new Error("MERCHANT_PROMOTION_CODE_OUTSIDE_RESERVED_PREFIX");
  if (!Number.isSafeInteger(input.discountValue) || input.discountValue <= 0) throw new Error("MERCHANT_PROMOTION_DISCOUNT_INVALID");
  if (input.discountKind === "PERCENT_BPS" && input.discountValue >= 10_000) throw new Error("MERCHANT_PROMOTION_DISCOUNT_INVALID");
  const startsAt = timestamp(input.startsAt, "MERCHANT_PROMOTION_START");
  const endsAt = timestamp(input.endsAt, "MERCHANT_PROMOTION_END");
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error("MERCHANT_PROMOTION_WINDOW_INVALID");
  if (!input.actor.trim()) throw new Error("ACTOR_REQUIRED");
  if (input.eligibleOfferRef && !db.prepare("SELECT 1 FROM offers WHERE offer_ref=?").get(input.eligibleOfferRef)) {
    throw new Error("OFFER_NOT_FOUND");
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error("MERCHANT_PROMOTION_VERSION_INVALID");
  const id = input.id ?? randomUUID();
  const existing = input.id ? db.prepare("SELECT version FROM merchant_promotion WHERE id=?").get(input.id) as { version: number } | undefined : undefined;
  if ((!existing && input.expectedVersion !== 0) || (existing && existing.version !== input.expectedVersion)) throw new Error("MERCHANT_PROMOTION_VERSION_CONFLICT");
  if (existing) {
    const result = db.prepare(`UPDATE merchant_promotion SET code_normalized=?,discount_kind=?,discount_value=?,eligible_offer_ref=?,
      starts_at=?,ends_at=?,active=?,actor=?,updated_at=?,version=version+1 WHERE id=? AND version=?`)
      .run(code, input.discountKind, input.discountValue, input.eligibleOfferRef ?? null, startsAt, endsAt,
        input.active === false ? 0 : 1, input.actor.trim(), now, id, input.expectedVersion);
    if (result.changes !== 1) throw new Error("MERCHANT_PROMOTION_VERSION_CONFLICT");
  } else {
    db.prepare(`INSERT INTO merchant_promotion
      (id,code_normalized,discount_kind,discount_value,eligible_offer_ref,starts_at,ends_at,active,actor,created_at,updated_at,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(id, code, input.discountKind, input.discountValue, input.eligibleOfferRef ?? null, startsAt, endsAt,
        input.active === false ? 0 : 1, input.actor.trim(), now, now);
  }
  const version = (db.prepare("SELECT version FROM merchant_promotion WHERE id=?").get(id) as { version: number }).version;
  return { id, code, version };
}

export function resolveCheckoutCode(
  db: Database.Database,
  rawCode: string | undefined,
  offerRef: string,
  catalogAmountKopecks: number,
  reservedPrefix: string,
  now: string,
): { refrefCheckoutCode?: string; promotion?: MerchantPromotionSnapshot } {
  const entered = rawCode?.trim();
  if (!entered) return {};
  const normalized = normalizePromotionCode(entered);
  const prefix = normalizeMerchantPromotionPrefix(reservedPrefix);
  if (!normalized.startsWith(prefix)) return { refrefCheckoutCode: entered };
  const row = db.prepare("SELECT * FROM merchant_promotion WHERE code_normalized=?").get(normalized) as PromotionRow | undefined;
  if (!row) throw new Error("MERCHANT_PROMOTION_NOT_RECOGNIZED");
  assertApplicable(row, offerRef, now);
  return { promotion: {
    id: row.id,
    code: row.code_normalized,
    discountKind: row.discount_kind,
    discountValue: row.discount_value,
    eligibleOfferRef: row.eligible_offer_ref,
    merchantDiscountKopecks: calculateDiscount(row, catalogAmountKopecks),
  } };
}

export function assertMerchantPromotionStillApplicable(
  db: Database.Database,
  snapshot: MerchantPromotionSnapshot | null,
  offerRef: string,
  catalogAmountKopecks: number,
  now: string,
) {
  if (!snapshot) return;
  const row = db.prepare("SELECT * FROM merchant_promotion WHERE id=?").get(snapshot.id) as PromotionRow | undefined;
  if (!row || row.code_normalized !== snapshot.code) throw new Error("CHECKOUT_QUOTE_STALE");
  try {
    assertApplicable(row, offerRef, now);
    if (calculateDiscount(row, catalogAmountKopecks) !== snapshot.merchantDiscountKopecks) throw new Error("CHECKOUT_QUOTE_STALE");
  } catch {
    throw new Error("CHECKOUT_QUOTE_STALE");
  }
}

export function listMerchantPromotions(db: Database.Database) {
  const rows = db.prepare(`SELECT id,code_normalized AS code,discount_kind AS discountKind,discount_value AS discountValue,
    eligible_offer_ref AS eligibleOfferRef,starts_at AS startsAt,ends_at AS endsAt,active,version,updated_at AS updatedAt
    FROM merchant_promotion ORDER BY created_at DESC`).all() as Array<{ id: string; code: string; discountKind: "FIXED" | "PERCENT_BPS";
      discountValue: number; eligibleOfferRef: string | null; startsAt: string | null; endsAt: string | null; active: number; version: number; updatedAt: string }>;
  return rows.map((row) => ({ ...row, active: Boolean(row.active) }));
}
