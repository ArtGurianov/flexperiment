import type Database from "better-sqlite3";
import { canonicalV2, emailHash, id, now, publicId, publicOrderNumber, sha256 } from "../crypto";
import { AgentReferralsAttributionError, ATTRIBUTION_RULE_VERSION, resolveOrderAttribution } from "../agent-referrals-attribution";
import { PartnerPromoPricingError, resolveCheckoutPromoTerms } from "../agent-referrals-partner-promo-pricing";
import { occurrenceInventory } from "../occurrence-inventory";
import { providerErrorEvidence, type PaymentProvider } from "../provider";
import { PromoPricingError, pricePromo } from "../promo-pricing";
import { checkoutRequestSchema, type CheckoutRequest, type ParticipantAgeBand } from "../types";
import { DomainError, legalManifest, one, type Row, withImmediateTransaction } from "./shared";
import type { CertificationCapability, CertificationClaim } from "../certification/capability";
import type { PresentedCertificationCapability } from "../release/sales-gate";

export type CheckoutInput = Omit<CheckoutRequest, "participant_age_band"> & { participant_age_band: string };

/**
 * A certification admitted by the checkout authority, handed down so the
 * checkout can present it to the gate and stamp the order with its run.
 *
 * The capability arrives already validated and already spent, inside the same
 * transaction as this order. The gate is still asked - with the capability -
 * because the fence it opens is the live one, and the facts below are derived
 * from the quote this checkout actually resolved.
 */
export type CertificationContext = {
  readonly capability: CertificationCapability;
  readonly claim: CertificationClaim;
  readonly run: { readonly runId: string; readonly releaseSha: string; readonly occurrenceId?: string | null };
  readonly runtimeReleaseSha: string;
  readonly deploymentSessionId: string;
};

interface CheckoutHost {
  readonly db: Database.Database;
  readonly provider: PaymentProvider;
  assertNewOrdersOpen(presented?: PresentedCertificationCapability): void;
  checkout(input: CheckoutInput, idempotencyKey: string, acceptance?: { ip?: string; userAgent?: string }, certification?: CertificationContext): { status_id: unknown; status: string; payment_url: unknown };
  checkoutResult(value: Row): { status_id: unknown; status: string; payment_url: unknown };
  checkoutStatus(statusId: string): { status_id: unknown; status: string; payment_url: unknown };
}

const isPromoEligible = (promo: Row | undefined) => Boolean(promo && promo.status === "ACTIVE" && (promo.agent_id === null || promo.agent_enabled === 1));
const activeAgentBySlug = (db: Database.Database, slug: string | undefined) => slug
  ? one(db, "SELECT id, slug FROM partners WHERE slug = ? AND enabled = 1", slug)
  : undefined;
const promoPrice = (price: number, type: unknown, value: unknown) => {
  try { return pricePromo(price, type, value); }
  catch (error) {
    if (error instanceof PromoPricingError) throw new DomainError(error.code, error.code === "PROMO_ZERO_PRICE_NOT_ALLOWED" ? 409 : 422);
    throw error;
  }
};
const resolvePromoTerms = (db: Database.Database, promo: { id: string; discount_type: string; discount_value: number }, occurrenceId: string, notEligibleCode: string) => {
  try { return resolveCheckoutPromoTerms(db, promo, occurrenceId, notEligibleCode); }
  catch (error) {
    if (error instanceof PartnerPromoPricingError) throw new DomainError(error.code, error.status);
    throw error;
  }
};
const resolveAttribution = (db: Database.Database, promo: { id: string; agent_id: string | null } | undefined, occurrenceId: string) => {
  try { return resolveOrderAttribution(db, promo, occurrenceId); }
  catch (error) {
    if (error instanceof AgentReferralsAttributionError) throw new DomainError(error.code, error.status);
    throw error;
  }
};
const isMinorAgeBand = (ageBand: ParticipantAgeBand) => ageBand !== "ADULT";
const requiresAccompanimentForAgeBand = (ageBand: ParticipantAgeBand) => ageBand === "MINOR_UNDER_14";
const checkoutRequestHashV2 = (input: CheckoutRequest) => `v2:${sha256(canonicalV2(input))}`;

const normalizeCheckoutInput = (input: unknown): CheckoutRequest => {
  const parsed = checkoutRequestSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("CHECKOUT_REQUEST_INVALID", 422);
  return parsed.data;
};

const formatOccurrenceDateTime = (value: unknown, timeZone: unknown) => {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "уточняется";
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: String(timeZone || "UTC") }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(date);
  }
};

export const replayCheckout = (host: CheckoutHost, input: unknown, idempotencyKey: string) => {
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", 400);
  const replay = one(host.db, `SELECT ci.canonical_request_hash, o.public_status_id AS status_id, p.state, p.status, p.payment_url
    FROM checkout_idempotency ci JOIN orders o ON o.id = ci.order_id JOIN payments p ON p.order_id = o.id
    WHERE ci.idempotency_key_hash = ?`, sha256(idempotencyKey));
  if (!replay) throw new DomainError("IDEMPOTENCY_REPLAY_NOT_FOUND", 404);
  if (!String(replay.canonical_request_hash).startsWith("v2:")) throw new DomainError("IDEMPOTENCY_CONTRACT_SUPERSEDED", 409);
  const parsed = checkoutRequestSchema.safeParse(input);
  const matches = parsed.success && replay.canonical_request_hash === checkoutRequestHashV2(parsed.data);
  if (!matches) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
  return host.checkoutResult(replay);
};

export const checkoutContext = (host: CheckoutHost, input: { occurrenceId: string; promoCode?: string; referralSlug?: string }) =>
  withImmediateTransaction(host.db, () => {
    const occurrence = one(host.db, "SELECT * FROM occurrences WHERE id = ?", input.occurrenceId);
    let promo: Row | undefined;
    if (input.promoCode) {
      promo = one(host.db, `SELECT p.*, a.enabled AS agent_enabled FROM promo_codes p
        LEFT JOIN partners a ON a.id = p.agent_id WHERE p.normalized_code = ?`, input.promoCode.trim().toUpperCase());
    }
    host.assertNewOrdersOpen();
    if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    if (input.promoCode && !promo) throw new DomainError("PROMO_NOT_FOUND", 404);
    if (promo && !isPromoEligible(promo)) throw new DomainError("PROMO_NOT_ELIGIBLE", 409);
    if (occurrence.visibility !== "PUBLISHED") throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    if (occurrence.sales_status !== "OPEN" || occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("SALES_NOT_OPEN", 409);
    const release = one(host.db, "SELECT * FROM legal_releases WHERE active = 1");
    if (!release) throw new DomainError("LEGAL_RELEASE_NOT_ACTIVE", 503);
    const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
    const availability = occurrenceInventory(host.db, occurrence as Row & { id: string }).available;
    if (availability <= 0) throw new DomainError("SOLD_OUT", 409);
    const referralAgent = activeAgentBySlug(host.db, input.referralSlug);
    const promoAgentId = promo?.agent_id as string | null ?? null;
    const attributedAgentId: string | null = promoAgentId ?? (referralAgent?.id as string | undefined) ?? null;
    const referralSlug = referralAgent?.slug as string | undefined;
    const price = Number(occurrence.price_kopecks);
    const promoTerms = promo ? resolvePromoTerms(host.db, { id: String(promo.id), discount_type: String(promo.discount_type), discount_value: Number(promo.discount_value) }, String(occurrence.id), "PROMO_NOT_ELIGIBLE") : null;
    const pricing = promoTerms ? promoPrice(price, promoTerms.discount_type, promoTerms.discount_value) : { discountKopecks: 0, finalAmountKopecks: price };
    const quoteId = id();
    const disclosure = occurrence.venue_status === "CONFIRMED"
      ? `${occurrence.venue_name}: ${occurrence.venue_address}`
      : `${String(occurrence.venue_disclosure_text)} Сообщим адрес участникам на email не позднее ${formatOccurrenceDateTime(occurrence.venue_announce_by, occurrence.timezone)}.`;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    host.db.prepare(`INSERT INTO quotes(id, occurrence_id, material_revision, legal_release_id, promo_id, attributed_agent_id, price_kopecks, discount_kopecks, final_amount_kopecks, venue_disclosure, expires_at, referral_slug, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot, promo_agent_id_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(quoteId, occurrence.id, occurrence.material_revision, release.id, promo?.id ?? null, attributedAgentId, price, pricing.discountKopecks, pricing.finalAmountKopecks, disclosure, expiresAt, referralSlug ?? null, promo?.code ?? null, promoTerms?.discount_type ?? null, promoTerms?.discount_value ?? null, promoAgentId);
    return { quote_id: quoteId, occurrence_id: occurrence.id, material_revision: occurrence.material_revision, availability, price_kopecks: price, discount_kopecks: pricing.discountKopecks, final_amount_kopecks: pricing.finalAmountKopecks, promo: promo ? { id: promo.id, code: promo.code, discount_type: promoTerms!.discount_type, discount_value: promoTerms!.discount_value, discount_kopecks: pricing.discountKopecks } : null, currency: "RUB", venue_disclosure: disclosure, legal_release: { id: release.id, version: release.version, manifest }, expires_at: expiresAt };
  });

export const checkout = (
  host: CheckoutHost, input: CheckoutInput, idempotencyKey: string,
  acceptance: { ip?: string; userAgent?: string } = {}, certification?: CertificationContext,
) => {
  /**
   * The facts the gate compares against are the server's own, derived from the
   * quote this checkout resolved - never anything the caller sent. A caller who
   * could state the amount or the occurrence would be telling the gate what to
   * check, which is not a gate.
   */
  const present = (quote: Row): PresentedCertificationCapability | undefined => certification && ({
    capability: certification.capability,
    claim: certification.claim,
    facts: {
      deploymentSessionId: certification.deploymentSessionId,
      runtimeReleaseSha: certification.runtimeReleaseSha,
      actualAmountKopecks: Number(quote.final_amount_kopecks),
      checkoutOccurrenceId: String(quote.occurrence_id),
    },
    expected: { runId: certification.run.runId, releaseSha: certification.run.releaseSha, occurrenceId: certification.run.occurrenceId },
  });
  const checkoutInput = normalizeCheckoutInput(input);
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", 400);
  const keyHash = sha256(idempotencyKey);
  const requestHash = checkoutRequestHashV2(checkoutInput);
  const result = withImmediateTransaction(host.db, () => {
    const replay = one(host.db, `SELECT ci.canonical_request_hash, o.public_status_id AS status_id, p.state, p.status, p.payment_url
      FROM checkout_idempotency ci JOIN orders o ON o.id = ci.order_id JOIN payments p ON p.order_id = o.id WHERE ci.idempotency_key_hash = ?`, keyHash);
    if (replay) {
      if (!String(replay.canonical_request_hash).startsWith("v2:")) throw new DomainError("IDEMPOTENCY_CONTRACT_SUPERSEDED", 409);
      if (replay.canonical_request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return { replay: true, status_id: replay.status_id, state: replay.state, status: replay.status, payment_url: replay.payment_url };
    }
    const quote = one(host.db, "SELECT * FROM quotes WHERE id = ?", checkoutInput.quote_id);
    if (!quote) { host.assertNewOrdersOpen(); throw new DomainError("QUOTE_EXPIRED", 409); }
    const occurrence = one(host.db, "SELECT o.*, c.title AS city_title FROM occurrences o JOIN cities c ON c.id = o.city_id WHERE o.id = ?", quote.occurrence_id);
    if (!occurrence) { host.assertNewOrdersOpen(present(quote)); throw new DomainError("QUOTE_STALE", 409); }
    host.assertNewOrdersOpen(present(quote));
    if (new Date(String(quote.expires_at)).getTime() < Date.now()) throw new DomainError("QUOTE_EXPIRED", 409);
    if (occurrence.material_revision !== quote.material_revision) throw new DomainError("QUOTE_STALE", 409);
    if (checkoutInput.customer_adult_confirmed !== true) throw new DomainError("CUSTOMER_ADULT_CONFIRMATION_REQUIRED", 422);
    const participantAgeBand = checkoutInput.participant_age_band;
    const participantIsMinor = isMinorAgeBand(participantAgeBand);
    const participantRequiresAdultAccompaniment = requiresAccompanimentForAgeBand(participantAgeBand);
    if (participantIsMinor && checkoutInput.minor_legal_representative_confirmed !== true) {
      throw new DomainError("MINOR_LEGAL_REPRESENTATIVE_CONFIRMATION_REQUIRED", 422);
    }
    if (!participantIsMinor && checkoutInput.minor_legal_representative_confirmed !== undefined) {
      throw new DomainError("UNEXPECTED_MINOR_LEGAL_REPRESENTATIVE_CONFIRMATION", 422);
    }
    const release = one(host.db, "SELECT * FROM legal_releases WHERE active = 1");
    if (!release || release.id !== quote.legal_release_id) throw new DomainError("LEGAL_VERSION_CHANGED", 409);
    const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
    let promo: Row | undefined;
    let promoTerms: { discount_type: string; discount_value: number } | null = null;
    if (quote.promo_id) {
      promo = one(host.db, `SELECT p.*, a.enabled AS agent_enabled FROM promo_codes p LEFT JOIN partners a ON a.id = p.agent_id WHERE p.id = ?`, quote.promo_id);
      if (!promo || !isPromoEligible(promo)) throw new DomainError("PROMO_NO_LONGER_ELIGIBLE", 409);
      promoTerms = resolvePromoTerms(host.db, { id: String(promo.id), discount_type: String(promo.discount_type), discount_value: Number(promo.discount_value) }, String(occurrence.id), "PROMO_NO_LONGER_ELIGIBLE");
      if (promoTerms.discount_type !== quote.discount_type_snapshot || Number(promoTerms.discount_value) !== Number(quote.discount_value_snapshot) || (promo.agent_id ?? null) !== (quote.promo_agent_id_snapshot ?? null)) throw new DomainError("QUOTE_STALE", 409);
    }
    if (occurrence.sales_status !== "OPEN" || occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("SALES_NOT_OPEN", 409);
    const promoAgentId = promo?.agent_id as string | null ?? null;
    const currentPricing = promoTerms ? promoPrice(Number(occurrence.price_kopecks), promoTerms.discount_type, promoTerms.discount_value) : { discountKopecks: 0, finalAmountKopecks: Number(occurrence.price_kopecks) };
    if (currentPricing.discountKopecks !== Number(quote.discount_kopecks) || currentPricing.finalAmountKopecks !== Number(quote.final_amount_kopecks)) throw new DomainError("QUOTE_STALE", 409);
    const attribution = resolveAttribution(host.db, promo ? { id: String(promo.id), agent_id: promoAgentId } : undefined, String(occurrence.id));
    if (occurrenceInventory(host.db, occurrence as Row & { id: string }).available <= 0) throw new DomainError("SOLD_OUT", 409);
    const orderId = id(); const bookingId = id(); const paymentId = id(); const statusId = publicId();
    let orderNumber = publicOrderNumber();
    while (one(host.db, "SELECT id FROM orders WHERE public_order_number = ?", orderNumber)) orderNumber = publicOrderNumber();
    const timestamp = now();
    const workshopDate = new Intl.DateTimeFormat("ru-RU", { timeZone: String(occurrence.timezone), day: "numeric", month: "long", year: "numeric" }).format(new Date(String(occurrence.starts_at)));
    const fiscalPurpose = "Оплата участия в мастер-классе ФЛЭКСПЕРИМЕНТ";
    const fiscalItemName = `Участие в мастер-классе ФЛЭКСПЕРИМЕНТ — ${String(occurrence.city_title)}, ${workshopDate}`;
    host.db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, attributed_agent_id, reward_type_snapshot, reward_value_snapshot, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot, promo_id_snapshot, promo_agent_id_snapshot, price_kopecks_snapshot, discount_kopecks_snapshot, fiscal_purpose_snapshot, fiscal_item_name_snapshot, public_offer_version, public_offer_sha256, public_offer_accepted_at, privacy_policy_version, privacy_policy_sha256, privacy_policy_presented_at, pd_consent_version, pd_consent_sha256, pd_consent_accepted_at, checkout_disclosure_version, checkout_disclosure_sha256, customer_adult_confirmed_at, customer_acceptance_ip, customer_acceptance_user_agent, participant_name, participant_age_band, participant_date_of_birth, participant_age_at_occurrence, participant_is_minor, participant_requires_adult_accompaniment, participant_is_customer, minor_legal_representative_confirmed_at, minor_legal_representative_confirmation_text, under_14_accompaniment_confirmed_at, under_14_accompaniment_confirmation_text, explicit_promo_id, resolved_partner_id, resolved_engagement_id, resolved_engagement_revision_id, resolved_promo_authorization_id, attribution_rule_version, resolution_reason, certification_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(orderId, statusId, orderNumber, occurrence.id, "", checkoutInput.customer_email.trim().toLowerCase(), emailHash(checkoutInput.customer_email), quote.final_amount_kopecks, quote.material_revision, quote.venue_disclosure, quote.legal_release_id, JSON.stringify(manifest), "DEPRECATED_NOT_EVIDENCE", attribution.attributed_agent_id, attribution.reward_type, attribution.reward_value, quote.promo_code_snapshot ?? null, quote.discount_type_snapshot ?? null, quote.discount_value_snapshot ?? null, quote.promo_id ?? null, quote.promo_agent_id_snapshot ?? null, quote.price_kopecks, quote.discount_kopecks, fiscalPurpose, fiscalItemName, manifest.documents.PUBLIC_OFFER.version, manifest.documents.PUBLIC_OFFER.sha256, timestamp, manifest.documents.PRIVACY_POLICY.version, manifest.documents.PRIVACY_POLICY.sha256, timestamp, manifest.documents.PD_CONSENT.version, manifest.documents.PD_CONSENT.sha256, timestamp, manifest.documents.CHECKOUT_DISCLOSURE.version, manifest.documents.CHECKOUT_DISCLOSURE.sha256, timestamp, acceptance.ip ?? null, acceptance.userAgent?.slice(0, 1_000) ?? null, null, participantAgeBand, null, null, Number(participantIsMinor), Number(participantRequiresAdultAccompaniment), null, participantIsMinor ? timestamp : null, participantIsMinor ? "Я являюсь совершеннолетним законным представителем несовершеннолетнего участника, для которого оформляю этот заказ." : null, null, null,
        attribution.explicit_promo_id, attribution.resolved_partner_id, attribution.resolved_engagement_id, attribution.resolved_engagement_revision_id, attribution.resolved_promo_authorization_id, ATTRIBUTION_RULE_VERSION, attribution.resolution_reason, certification?.run.runId ?? null);
    host.db.prepare("INSERT INTO bookings(id, order_id, occurrence_id, status) VALUES (?, ?, ?, 'RESERVED')").run(bookingId, orderId, occurrence.id);
    host.db.prepare(`INSERT INTO payments(id, order_id, state, status, provider_idempotency_key, creation_started_at) VALUES (?, ?, 'CREATING', 'PENDING', ?, ?)`)
      .run(paymentId, orderId, publicId(), timestamp);
    host.db.prepare("INSERT INTO checkout_idempotency(idempotency_key_hash, canonical_request_hash, order_id) VALUES (?, ?, ?)").run(keyHash, requestHash, orderId);
    return { replay: false, order_id: orderId, payment_id: paymentId, status_id: statusId, amount_kopecks: Number(quote.final_amount_kopecks) };
  });
  if ("replay" in result && result.replay) return host.checkoutResult(result);
  return { status_id: result.status_id, status: "PROCESSING" as const, payment_url: null };
};

export const checkoutStatus = (host: CheckoutHost, statusId: string) => {
  const payment = one(host.db, `SELECT p.state, p.status, p.payment_url
    FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?`, statusId);
  if (!payment) throw new DomainError("CHECKOUT_NOT_FOUND", 404);
  return host.checkoutResult({ status_id: statusId, ...payment });
};

/** Performs external payment creation only after checkout state has committed. */
/**
 * The external half, on its own, because two callers need it: the ordinary
 * checkout and a certification admission that already committed its order in
 * the authority's transaction. Duplicating it would be duplicating the
 * CREATE_UNKNOWN discipline, which is the last thing to have two copies of.
 */
export const settleCheckoutPayment = async (host: CheckoutHost, statusId: string, successBaseUrl: string) => {
  const current = host.checkoutStatus(statusId);
  const payment = one(host.db, `SELECT p.*, p.id AS payment_id, o.id AS order_id, o.amount_kopecks, o.customer_email, o.fiscal_purpose_snapshot, o.fiscal_item_name_snapshot
    FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?`, statusId);
  if (!payment || payment.state !== "CREATING") return current;
  return settleCreatingPayment(host, statusId, successBaseUrl, payment);
};

export const checkoutAsync = async (
  host: CheckoutHost, input: CheckoutInput, idempotencyKey: string, successBaseUrl: string,
  acceptance: { ip?: string; userAgent?: string } = {}, certification?: CertificationContext,
) => {
  const first = host.checkout(input, idempotencyKey, acceptance, certification);
  const payment = one(host.db, `SELECT p.*, p.id AS payment_id, o.id AS order_id, o.amount_kopecks, o.customer_email, o.fiscal_purpose_snapshot, o.fiscal_item_name_snapshot
    FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?`, first.status_id);
  if (!payment || payment.state !== "CREATING") return first;
  return settleCreatingPayment(host, String(first.status_id), successBaseUrl, payment);
};

const settleCreatingPayment = async (host: CheckoutHost, statusId: string, successBaseUrl: string, payment: Row) => {
  try {
    host.db.prepare("UPDATE payments SET provider_request_started_at = ?, updated_at = ? WHERE id = ? AND state = 'CREATING'").run(now(), now(), payment.payment_id);
    if (!payment.fiscal_item_name_snapshot || !payment.fiscal_purpose_snapshot) throw new Error("Order has no immutable fiscal snapshot.");
    const created = await host.provider.createPayment({ paymentId: String(payment.payment_id), paymentLinkId: String(payment.payment_id), amountKopecks: Number(payment.amount_kopecks), idempotencyKey: String(payment.provider_idempotency_key), successUrl: `${successBaseUrl}/payment/success?order=${statusId}`, customerEmail: String(payment.customer_email), purpose: String(payment.fiscal_purpose_snapshot), receiptItemName: String(payment.fiscal_item_name_snapshot) });
    host.db.prepare("UPDATE payments SET state = 'CREATED', provider_payment_id = ?, payment_url = ?, updated_at = ? WHERE id = ? AND state = 'CREATING'").run(created.providerPaymentId, created.paymentUrl, now(), payment.payment_id);
  } catch (error) {
    const evidence = providerErrorEvidence(error);
    host.db.prepare(`UPDATE payments
      SET state = 'CREATE_UNKNOWN', provider_error_class = ?, provider_error_code = ?, updated_at = ?
      WHERE id = ? AND state = 'CREATING'`).run(evidence.provider_error_class, evidence.provider_error_code, now(), payment.payment_id);
  }
  return host.checkoutStatus(statusId);
};
