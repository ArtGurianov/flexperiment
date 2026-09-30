import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const normalizeEmail = (email: string) => email.trim().toLocaleLowerCase("en-US");

export function getOrCreateCustomer(db: Database.Database, email: string, displayName?: string | null) {
  const normalized = normalizeEmail(email);
  const existing = db.prepare("SELECT id,email_normalized,auth_user_id FROM customers WHERE email_normalized=?").get(normalized) as {
    id: string; email_normalized: string; auth_user_id: string | null;
  } | undefined;
  if (existing) return existing;
  const id = randomUUID();
  db.prepare("INSERT INTO customers(id,email_normalized,display_name) VALUES (?,?,?)").run(id, normalized, displayName ?? null);
  return { id, email_normalized: normalized, auth_user_id: null };
}

export function bindVerifiedAuthUser(db: Database.Database, authUser: { id: string; email: string; name?: string | null }) {
  const run = db.transaction(() => {
    const customer = getOrCreateCustomer(db, authUser.email, authUser.name);
    const collision = db.prepare("SELECT id FROM customers WHERE auth_user_id=? AND id<>?").get(authUser.id, customer.id);
    if (collision) throw new Error("AUTH_USER_ALREADY_BOUND");
    if (customer.auth_user_id && customer.auth_user_id !== authUser.id) throw new Error("CUSTOMER_ALREADY_BOUND");
    db.prepare("UPDATE customers SET auth_user_id=?,display_name=COALESCE(display_name,?),updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(authUser.id, authUser.name ?? null, customer.id);
    return customer.id;
  });
  return run.immediate();
}

export function customerIdForAuthUser(db: Database.Database, authUserId: string): string | null {
  const row = db.prepare("SELECT id FROM customers WHERE auth_user_id=?").get(authUserId) as { id: string } | undefined;
  return row?.id ?? null;
}

export type ConsentInput = {
  readonly personalDataVersion: string;
  readonly accountTermsVersion: string;
  readonly marketingConsent: boolean;
  readonly marketingDocumentVersion?: string;
  readonly source: string;
};

export function recordAccountConsents(db: Database.Database, customerId: string, input: ConsentInput, now = new Date().toISOString()) {
  if (!input.personalDataVersion || !input.accountTermsVersion) throw new Error("REQUIRED_CONSENT_VERSION_MISSING");
  if (input.marketingConsent && !input.marketingDocumentVersion) throw new Error("MARKETING_CONSENT_VERSION_MISSING");
  const insertAccount = db.prepare(`INSERT INTO account_consents(id,customer_id,kind,document_version,recorded_at,source)
    VALUES (?,?,?,?,?,?) ON CONFLICT(customer_id,kind,document_version) DO NOTHING`);
  const run = db.transaction(() => {
    insertAccount.run(randomUUID(), customerId, "PERSONAL_DATA", input.personalDataVersion, now, input.source);
    insertAccount.run(randomUUID(), customerId, "ACCOUNT_TERMS", input.accountTermsVersion, now, input.source);
    db.prepare(`INSERT INTO marketing_consents(id,customer_id,granted,document_version,recorded_at,source)
      VALUES (?,?,?,?,?,?)`).run(
      randomUUID(), customerId, Number(input.marketingConsent),
      input.marketingDocumentVersion ?? "not-granted", now, input.source,
    );
  });
  run.immediate();
}
