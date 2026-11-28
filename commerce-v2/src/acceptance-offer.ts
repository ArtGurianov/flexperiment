import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ErasureLedgerError } from "./erasure-ledger";

const utcDeadline = z.iso.datetime();
export const ACCEPTANCE_WINDOW_MAX_MS = 14 * 24 * 60 * 60_000;

export function acceptanceDeadline(value: unknown, now: string): string | null {
  if (!utcDeadline.safeParse(value).success || typeof value !== "string") return null;
  const expiresAt = new Date(value);
  return expiresAt.getTime() > Date.parse(now) ? expiresAt.toISOString() : null;
}

function readAcceptanceLists(db: Database.Database) {
  const rows = db.prepare(`SELECT id,product_id,acceptance_allowlist_json FROM offers
    WHERE acceptance_allowlist_json<>'[]'`).all() as Array<{ id: string; product_id: string; acceptance_allowlist_json: string }>;
  return rows.map(row => {
    return { id: row.id, productId: row.product_id, emails: readAcceptanceEmails(row.acceptance_allowlist_json) };
  });
}

export function readAcceptanceEmails(json: string): string[] {
  const decoded: unknown = JSON.parse(json);
  if (!Array.isArray(decoded) || decoded.some(value => typeof value !== "string")) {
    throw new ErasureLedgerError("ERASURE_ACCEPTANCE_ALLOWLIST_UNCLASSIFIED");
  }
  return decoded as string[];
}

export function expireAcceptanceQuotes(db: Database.Database, offerId: string | null, now: string, customerIds?: readonly string[]) {
  if (customerIds?.length === 0) return;
  db.prepare(`UPDATE checkout_quotes SET state='EXPIRED',failure_code='CHECKOUT_QUOTE_EXPIRED',updated_at=@now
    WHERE consumed_at IS NULL AND sale_mode_at_quote='ACCEPTANCE_ONLY'
      AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW')
      AND (@offerId IS NULL OR offer_id=@offerId)
      AND (@customers IS NULL OR customer_id IN (SELECT value FROM json_each(@customers)))`)
    .run({ offerId, now, customers: customerIds ? JSON.stringify(customerIds) : null });
}

export function assertNoErasedAcceptanceEmail(db: Database.Database, matches: (email: string) => boolean) {
  if (readAcceptanceLists(db).some(list => list.emails.some(matches))) {
    throw new ErasureLedgerError("ERASURE_ACCEPTANCE_DISPOSITION_REQUIRED");
  }
}

/** Runs inside the admitted, schema-checked erasure write transaction. */
export function removeErasedAcceptanceEmail(db: Database.Database, matches: (email: string) => boolean, now: string) {
  const save = db.prepare("UPDATE offers SET acceptance_allowlist_json=?,updated_at=? WHERE id=?");
  const bump = db.prepare("UPDATE products SET version=version+1,updated_at=? WHERE id=?");
  let count = 0;
  let customerIds: string[] | undefined;
  for (const list of readAcceptanceLists(db)) {
    const remaining = list.emails.filter(email => !matches(email));
    if (remaining.length === list.emails.length) continue;
    save.run(JSON.stringify(remaining), now, list.id);
    bump.run(now, list.productId);
    // Historical schema revisions before 0030 have no frozen sale mode.
    if ((db.prepare("PRAGMA table_info(checkout_quotes)").all() as Array<{ name: string }>)
      .some(column => column.name === "sale_mode_at_quote")) {
      customerIds ??= (db.prepare("SELECT id,email_normalized FROM customers").all() as Array<{ id: string; email_normalized: string }>)
        .filter(customer => matches(customer.email_normalized)).map(customer => customer.id);
      expireAcceptanceQuotes(db, list.id, now, customerIds);
    }
    count++;
  }
  return count;
}

/** Expiry gates checkout immediately. This sweep removes dead test data even
 * when nobody visits the offer. Its transaction also invalidates stale forms. */
export function closeExpiredAcceptanceOffers(db: Database.Database, now: string) {
  return db.transaction(() => {
    const expired = db.prepare(`SELECT o.id,o.offer_ref,o.product_id,p.product_ref,o.acceptance_expires_at,
        json_array_length(o.acceptance_allowlist_json) AS count
      FROM offers o JOIN products p ON p.id=o.product_id WHERE o.sale_mode='ACCEPTANCE_ONLY'
        AND (julianday(o.acceptance_expires_at) IS NULL OR julianday(o.acceptance_expires_at)<=julianday(?))`).all(now) as Array<{
          id: string; offer_ref: string; product_id: string; product_ref: string; acceptance_expires_at: string | null; count: number;
        }>;
    const bump = db.prepare("UPDATE products SET version=version+1,updated_at=? WHERE id=?");
    const close = db.prepare(`UPDATE offers SET sale_mode='CLOSED',acceptance_allowlist_json='[]',acceptance_expires_at=NULL,updated_at=? WHERE id=?`);
    const audit = db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,'SYSTEM_ACCEPTANCE_EXPIRY','ACCEPTANCE_OFFER_EXPIRED','PRODUCT',?,?,?)`);
    for (const offer of expired) {
      expireAcceptanceQuotes(db, offer.id, now);
      close.run(now, offer.id);
      bump.run(now, offer.product_id);
      audit.run(randomUUID(), offer.product_ref, JSON.stringify({ offerRef: offer.offer_ref,
        clearedEmailCount: offer.count, expiredAt: utcDeadline.safeParse(offer.acceptance_expires_at).success ? offer.acceptance_expires_at : null }), now);
    }
    return expired.length;
  }).immediate();
}
