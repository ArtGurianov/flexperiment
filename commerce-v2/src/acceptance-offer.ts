import type Database from "better-sqlite3";
import { z } from "zod";
import { ErasureLedgerError } from "./erasure-ledger";

const utcDeadline = z.iso.datetime();

export function acceptanceDeadline(value: unknown, now: string): string | null {
  if (!utcDeadline.safeParse(value).success || typeof value !== "string") return null;
  const expiresAt = new Date(value);
  return expiresAt.getTime() > Date.parse(now) ? expiresAt.toISOString() : null;
}

function readAcceptanceLists(db: Database.Database) {
  const rows = db.prepare(`SELECT id,product_id,acceptance_allowlist_json FROM offers
    WHERE acceptance_allowlist_json<>'[]'`).all() as Array<{ id: string; product_id: string; acceptance_allowlist_json: string }>;
  return rows.map(row => {
    const decoded: unknown = JSON.parse(row.acceptance_allowlist_json);
    if (!Array.isArray(decoded) || decoded.some(value => typeof value !== "string")) {
      throw new ErasureLedgerError("ERASURE_ACCEPTANCE_ALLOWLIST_UNCLASSIFIED");
    }
    return { id: row.id, productId: row.product_id, emails: decoded as string[] };
  });
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
  for (const list of readAcceptanceLists(db)) {
    const remaining = list.emails.filter(email => !matches(email));
    if (remaining.length === list.emails.length) continue;
    save.run(JSON.stringify(remaining), now, list.id);
    bump.run(now, list.productId);
    count++;
  }
  return count;
}

/** Expiry gates checkout immediately. This sweep removes dead test data even
 * when nobody visits the offer. Its transaction also invalidates stale forms. */
export function closeExpiredAcceptanceOffers(db: Database.Database, now: string) {
  const expired = "sale_mode='ACCEPTANCE_ONLY' AND (julianday(acceptance_expires_at) IS NULL OR acceptance_expires_at<=?)";
  return db.transaction(() => {
    db.prepare(`UPDATE products SET version=version+1,updated_at=?
      WHERE id IN (SELECT product_id FROM offers WHERE ${expired})`).run(now, now);
    return db.prepare(`UPDATE offers SET sale_mode='CLOSED',acceptance_allowlist_json='[]',
      acceptance_expires_at=NULL,updated_at=? WHERE ${expired}`).run(now, now).changes;
  }).immediate();
}
