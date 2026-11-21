import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { confirmCheckout, prepareCheckout, type CheckoutPolicyConfig, type PaymentRail } from "../../src/checkout";
import { getOrCreateCustomer } from "../../src/customers";
import { capabilityHash, labLegalReview, type LabAcceptance } from "../../src/lab-tickets";

/**
 * Synthetic fixtures for FLEX-60: a LAB purchase needs a confirmed account (a verified sign-in bound
 * the customer's email) and an explicit acceptance of the active LAB Stage B release.
 * Never runtime admission or launch legal material.
 */
export function confirmLabBuyer(db: Database.Database, customerId: string) {
  const customer = db.prepare("SELECT email_normalized,auth_user_id FROM customers WHERE id=?").get(customerId) as
    { email_normalized: string; auth_user_id: string | null } | undefined;
  if (!customer) throw new Error("SYNTHETIC_CUSTOMER_MISSING");
  if (customer.auth_user_id) return customer.auth_user_id;
  const userId = `synthetic-lab-user-${customerId}`;
  db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run(userId, "Synthetic", customer.email_normalized);
  db.prepare("UPDATE customers SET auth_user_id=? WHERE id=?").run(userId, customerId);
  return userId;
}

/** Confirms every customer the fixture created so far (LAB tests that add buyers inline). */
export function confirmAllLabBuyers(db: Database.Database) {
  for (const { id } of db.prepare("SELECT id FROM customers WHERE auth_user_id IS NULL").all() as Array<{ id: string }>) confirmLabBuyer(db, id);
}

export function labAcceptanceFor(db: Database.Database): LabAcceptance {
  const review = labLegalReview(db);
  return { personalDataConsent: true, termsAccepted: true, receiptContactAccepted: true,
    releaseVersion: review.releaseVersion, manifestSha256: review.manifestSha256 };
}

/** The acceptance when an active LAB Stage B release exists, else nothing (course-only fixtures). */
export function labAcceptanceIfActive(db: Database.Database): LabAcceptance | undefined {
  try { return labAcceptanceFor(db); } catch { return undefined; }
}

/**
 * A guest purchase as it exists from before FLEX-60 closed new guest purchases: an order-scoped
 * capability, a customer no verified sign-in has bound, and an order on it. The domain now refuses to
 * create one, so the fixture creates the order on a briefly confirmed customer, attaches the guest
 * capability and unbinds the customer again. `stopAt: "QUOTE"` leaves an unconsumed legacy guest intent.
 */
export async function seedHistoricalGuestLabPurchase(db: Database.Database, rail: PaymentRail, config: CheckoutPolicyConfig, input: {
  email: string; accessToken: string; offerRef: string; now: string; scenario?: string; storefrontOrigin?: string; stopAt?: "QUOTE";
}) {
  const customer = getOrCreateCustomer(db, input.email);
  const userId = customer.auth_user_id ? null : confirmLabBuyer(db, customer.id);
  const orderPublicId = randomUUID();
  try {
    const prepared = await prepareCheckout(db, rail, config, { customerId: customer.id, customerEmail: customer.email_normalized,
      offerRef: input.offerRef, previewIdempotencyKey: `${orderPublicId}:preview:preview`, orderPublicId, scenario: input.scenario,
      storefront: "LAB", storefrontOrigin: input.storefrontOrigin }, input.now);
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error(`SYNTHETIC_QUOTE_EXPECTED_${prepared.state}`);
    const paid = input.stopAt === "QUOTE" ? undefined : await confirmCheckout(db, rail, config, { customerId: customer.id,
      customerEmail: customer.email_normalized, quoteId: prepared.quoteId, idempotencyKey: `${orderPublicId}:pay:payment`,
      expectedOrderPublicId: orderPublicId, storefront: "LAB", labAcceptance: labAcceptanceFor(db) }, input.now);
    db.prepare(`INSERT INTO lab_guest_access(order_public_id,customer_id,token_sha256,acceptance_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`).run(orderPublicId, customer.id, capabilityHash(input.accessToken),
      paid ? JSON.stringify({ ...labAcceptanceFor(db), recordedAt: input.now, source: "LAB_ORDER_CONFIRM", evidenceStatus: "ORDER_SCOPED_UNVERIFIED_EMAIL" }) : null,
      input.now, input.now);
    return { token: input.accessToken, orderPublicId, customerId: customer.id, prepared, paid };
  } finally {
    if (userId) {
      db.prepare("UPDATE customers SET auth_user_id=NULL WHERE id=?").run(customer.id);
      db.prepare('DELETE FROM "user" WHERE id=?').run(userId);
    }
  }
}
