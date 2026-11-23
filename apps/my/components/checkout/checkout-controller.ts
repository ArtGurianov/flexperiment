/** FLEX-122: shared my checkout for LMS and LAB offers.
 *
 * The controller owns the buyer flow; Commerce owns every decision. The intent id names an offer;
 * Commerce derives the storefront, price, documents, fiscal policy and rights from that offer and its
 * own state. The controller never creates anything before a MY-session preview, accepts only an
 * explicit acceptance, resends a confirm under the same key and body, and reads the authoritative
 * order status after any return. It is framework-free so the flow is tested without a browser. */
import { acceptStatus, normalizeStatus, safePaymentUrl, TERMINAL, type BuyerStatus, type CheckoutKind } from "./buyer-status";
import type { ConfirmBody, IntentRecord, IntentStore } from "./intent-store";

export type LegalDocument = { kind: string; version?: string; url: string };
export type CheckoutReview = {
  quoteId: string;
  kind: CheckoutKind;
  baseAmountKopecks: number;
  merchantDiscountKopecks: number;
  referralDiscountKopecks: number;
  discountKopecks: number;
  finalAmountKopecks: number;
  expiresAt: string;
  occurrence: { startsAt?: string; timezone?: string; title?: string; venue?: string } | null;
  priceNotice: { code: string; quotedAmountKopecks: number; displayedAmountKopecks?: number; currentAmountKopecks?: number } | null;
  documents: LegalDocument[];
  releaseVersion: string;
  manifestSha256: string;
  receiptEmail?: string;
};

export type CheckoutNotice = "QUOTE_RENEWED" | "DOCUMENTS_CHANGED" | "STATUS_DELAYED" | "CONFIRM_OUTCOME_UNKNOWN" | "CONFIRM_AGAIN";

export type CheckoutState =
  | { phase: "LOADING" }
  | { phase: "SIGN_IN"; href: string }
  | { phase: "ACCOUNT_CONFIRMATION"; href: string }
  | { phase: "CONSENT_REQUIRED"; href: string }
  | { phase: "REVIEW"; review: CheckoutReview; busy: boolean; notice?: CheckoutNotice }
  | { phase: "REDIRECTING"; kind: CheckoutKind }
  | { phase: "STATUS"; kind: CheckoutKind; status: BuyerStatus; polling: boolean; notice?: CheckoutNotice }
  | { phase: "ALREADY_OWNED"; kind: CheckoutKind }
  | { phase: "ORDER_NOT_FOUND" }
  | { phase: "OFFER_MISMATCH" }
  | { phase: "UNAVAILABLE"; code: string; retryable: boolean; kind: CheckoutKind };

export type LabAcceptanceInput = { personalDataConsent: boolean; termsAccepted: boolean; receiptContactAccepted: boolean };
export type CourseAcceptanceInput = { termsAccepted: boolean };

export type CheckoutDeps = {
  intentId: string;
  offerRef: string;
  /** `?order=` after a provider return; only read, never trusted. */
  returnedOrder: string | null;
  store: IntentStore;
  fetch: typeof fetch;
  myOrigin: string;
  navigate: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  newKey?: () => string;
  pollIntervalMs?: number;
  pollAttempts?: number;
};

const SIGN_IN_CODES = new Set(["SIGN_IN_REQUIRED", "SESSION_AUDIENCE_FORBIDDEN", "ACCOUNT_BINDING_MISMATCH"]);
const QUOTE_RENEW_CODES = new Set(["CHECKOUT_QUOTE_EXPIRED", "CHECKOUT_QUOTE_STALE", "CHECKOUT_QUOTE_UNAVAILABLE",
  "CHECKOUT_QUOTE_NOT_FOUND", "IDEMPOTENCY_KEY_REUSED"]);
const DOCUMENT_RENEW_CODES = new Set(["PAID_CHECKOUT_TERMS_ACCEPTANCE_REQUIRED", "LAB_CONSENT_REQUIRED"]);
const OWNED_CODES = new Set(["ALREADY_OWNED", "CHECKOUT_ALREADY_PAID"]);
const UNAVAILABLE_FINAL = new Set(["OFFER_NOT_AVAILABLE", "OFFER_CLOSED", "FREE_PRODUCT_CHECKOUT_FORBIDDEN",
  "CHECKOUT_STOREFRONT_MISMATCH", "ACCEPTANCE_ONLY", "PAYMENTS_DISABLED", "SALES_STOPPED", "LEGAL_RELEASE_REQUIRED",
  "LAB_LEGAL_RELEASE_REQUIRED", "LAB_OCCURRENCE_NOT_FOUND", "LAB_SOLD_OUT", "FISCAL_POLICY_NOT_QUALIFIED"]);

type Answer = { ok: boolean; status: number; body: Record<string, unknown> };

export const offerKind = (offerRef: string): CheckoutKind => offerRef.startsWith("lab:") ? "LAB" : "COURSE";

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

/** The frozen LAB occurrence (Commerce `freezeLine`): only display strings reach the view. The venue
 * is `BuyerVenueDisclosure`: confirmed name and address, or the to-be-announced disclosure text. */
function displayOccurrence(raw: Record<string, unknown>): NonNullable<CheckoutReview["occurrence"]> {
  const venue = raw.venue && typeof raw.venue === "object" ? raw.venue as Record<string, unknown> : undefined;
  const venueText = venue?.status === "CONFIRMED" ? [text(venue.name), text(venue.address)].filter(Boolean).join(", ")
    : venue?.status === "TO_BE_ANNOUNCED" ? text(venue.disclosureText) : undefined;
  const result: NonNullable<CheckoutReview["occurrence"]> = {};
  const title = text(raw.title); const startsAt = text(raw.startsAt); const timezone = text(raw.timezone);
  if (title) result.title = title;
  if (startsAt && !Number.isNaN(Date.parse(startsAt))) result.startsAt = startsAt;
  if (timezone) result.timezone = timezone;
  if (venueText) result.venue = venueText;
  return result;
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export class CheckoutController {
  private state: CheckoutState = { phase: "LOADING" };
  private listeners = new Set<(state: CheckoutState) => void>();
  private disposed = false;
  private confirming: Promise<void> | null = null;
  /** The exact confirm body for the in-memory payment key; never persisted (it carries the receipt e-mail). */
  private frozenConfirm: { paymentKey: string; body: ConfirmBody } | null = null;
  private statusSeq = 0;
  private applied: { seq: number; status: BuyerStatus } | null = null;
  private pollGeneration = 0;
  private readonly kind: CheckoutKind;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CheckoutDeps) {
    this.kind = offerKind(deps.offerRef);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get current() { return this.state; }
  get returnPath() { return `/checkout/${this.deps.intentId}`; }
  get signInHref() { return `/sign-in?next=${encodeURIComponent(this.returnPath)}`; }

  subscribe(listener: (state: CheckoutState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose() { this.disposed = true; this.pollGeneration += 1; this.listeners.clear(); }

  private set(state: CheckoutState) {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private async call(path: string, init: RequestInit = {}): Promise<Answer> {
    try {
      const response = await this.deps.fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
      let body: Record<string, unknown> = {};
      try { body = await response.json() as Record<string, unknown>; } catch { /* empty or non-JSON answer */ }
      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, status: 0, body: { code: "NETWORK_UNAVAILABLE" } };
    }
  }

  /** Entry after load, sign-in, refresh or provider return. */
  async start() {
    const record = this.deps.store.load();
    const returned = this.deps.returnedOrder;
    if (returned) return this.observe(returned, record.orderPublicId === returned);
    if (record.orderPublicId) return this.observe(record.orderPublicId, true);
    if (record.paymentKey && record.quoteId) {
      // A confirm was sent before the refresh; its answer may be lost. Resend the same key: Commerce
      // returns the order it already started. If the first send never arrived, it asks for acceptance
      // again and the buyer sees the same quote (same preview key) to accept explicitly.
      const body = this.frozenConfirm?.paymentKey === record.paymentKey ? this.frozenConfirm.body
        : { quoteId: record.quoteId, returnPath: this.returnPath };
      return this.sendConfirm(record, body, record.paymentKey, this.frozenConfirm?.paymentKey !== record.paymentKey);
    }
    return this.preview();
  }

  async preview(notice?: CheckoutNotice, attempt = 0): Promise<void> {
    const record = this.deps.store.load();
    const answer = await this.call("/v1/checkout/preview", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": record.previewKey },
      body: JSON.stringify({ offerRef: this.deps.offerRef }),
    });
    if (this.disposed) return;
    const code = typeof answer.body.code === "string" ? answer.body.code : undefined;
    if (answer.ok && answer.body.state === "RESOLUTION_PENDING") {
      if (attempt >= 5) return this.set({ phase: "UNAVAILABLE", code: "CHECKOUT_RESOLUTION_PENDING", retryable: true, kind: this.kind });
      await this.sleep(this.deps.pollIntervalMs ?? 2000);
      return this.preview(notice, attempt + 1);
    }
    if (!answer.ok) return this.refusal(code ?? "CHECKOUT_PREVIEW_UNAVAILABLE", answer, () => this.preview("QUOTE_RENEWED", attempt + 1), attempt);
    if (answer.body.checkoutUrl) {
      // A Refref resolution page: attribution is admitted separately (FLEX-124), never by this checkout.
      return this.set({ phase: "UNAVAILABLE", code: "CHECKOUT_CONTOUR_NOT_ADMITTED", retryable: false, kind: this.kind });
    }
    const review = this.toReview(answer.body);
    if (review === "MISMATCH") { this.deps.store.clear(); return this.set({ phase: "OFFER_MISMATCH" }); }
    if (!review) return this.set({ phase: "UNAVAILABLE", code: "LEGAL_REVIEW_UNAVAILABLE", retryable: true, kind: this.kind });
    this.deps.store.update({ quoteId: review.quoteId, kind: review.kind });
    this.set({ phase: "REVIEW", review, busy: false, ...(notice ? { notice } : {}) });
  }

  /** The server answer becomes a review only when it is about this offer and carries its documents. */
  private toReview(body: Record<string, unknown>): CheckoutReview | "MISMATCH" | null {
    if (body.offerRef !== undefined && body.offerRef !== this.deps.offerRef) return "MISMATCH";
    const serverKind = body.kind === "LAB" ? "LAB" : body.kind === "ONLINE_COURSE" || body.kind === "COURSE_BUNDLE" ? "COURSE" : undefined;
    const occurrence = body.occurrence && typeof body.occurrence === "object" ? displayOccurrence(body.occurrence as Record<string, unknown>) : null;
    const kind = serverKind ?? (occurrence ? "LAB" : "COURSE");
    if (kind !== this.kind) return "MISMATCH";
    if (body.state !== "PRICE_REVIEW_REQUIRED" || typeof body.quoteId !== "string" || !isCount(body.finalAmountKopecks)) return null;
    const legal = (kind === "LAB" ? body.labLegal : body.legalAcceptance) as
      { releaseVersion?: unknown; manifestSha256?: unknown; receiptEmail?: unknown; documents?: unknown } | undefined;
    if (!legal || typeof legal.releaseVersion !== "string" || typeof legal.manifestSha256 !== "string" || !Array.isArray(legal.documents)) return null;
    const documents = (legal.documents as Array<Record<string, unknown>>).flatMap((document) => {
      const url = safePaymentUrl(document?.url, this.deps.myOrigin);
      return typeof document?.kind === "string" && url ? [{ kind: document.kind, url,
        ...(typeof document.version === "string" ? { version: document.version } : {}) }] : [];
    });
    if (!documents.length) return null;
    if (kind === "COURSE" && typeof legal.receiptEmail !== "string") return null;
    const amount = (value: unknown) => isCount(value) ? value : 0;
    return {
      quoteId: body.quoteId, kind,
      baseAmountKopecks: amount(body.baseAmountKopecks), merchantDiscountKopecks: amount(body.merchantDiscountKopecks),
      referralDiscountKopecks: amount(body.referralDiscountKopecks), discountKopecks: amount(body.discountKopecks),
      finalAmountKopecks: body.finalAmountKopecks, expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
      occurrence, priceNotice: (body.priceNotice as CheckoutReview["priceNotice"]) ?? null, documents,
      releaseVersion: legal.releaseVersion, manifestSha256: legal.manifestSha256,
      ...(typeof legal.receiptEmail === "string" ? { receiptEmail: legal.receiptEmail } : {}),
    };
  }

  /** Explicit acceptance only. A second click while the first is in flight joins it. */
  confirm(input: CourseAcceptanceInput | LabAcceptanceInput): Promise<void> {
    if (this.confirming) return this.confirming;
    const state = this.state;
    if (state.phase !== "REVIEW" || state.busy) return Promise.resolve();
    const { review } = state;
    let body: ConfirmBody;
    if (review.kind === "LAB") {
      const lab = input as LabAcceptanceInput;
      if (lab.personalDataConsent !== true || lab.termsAccepted !== true || lab.receiptContactAccepted !== true) return Promise.resolve();
      body = { quoteId: review.quoteId, returnPath: this.returnPath, labAcceptance: { personalDataConsent: true, termsAccepted: true,
        receiptContactAccepted: true, releaseVersion: review.releaseVersion, manifestSha256: review.manifestSha256 } };
    } else {
      if (input.termsAccepted !== true) return Promise.resolve();
      body = { quoteId: review.quoteId, returnPath: this.returnPath, legalAcceptance: { accepted: true,
        releaseVersion: review.releaseVersion, manifestSha256: review.manifestSha256, receiptEmail: review.receiptEmail! } };
    }
    this.set({ ...state, busy: true });
    const current = this.deps.store.load();
    // Key and body are frozen before the first send; a repeat (retry, lost answer) resends both.
    const reuse = this.frozenConfirm && current.paymentKey === this.frozenConfirm.paymentKey && this.frozenConfirm.body.quoteId === review.quoteId;
    const paymentKey = reuse ? this.frozenConfirm!.paymentKey
      : current.paymentKey && current.quoteId === review.quoteId ? current.paymentKey : (this.deps.newKey ?? (() => crypto.randomUUID()))();
    const frozen = reuse ? this.frozenConfirm!.body : body;
    this.frozenConfirm = { paymentKey, body: frozen };
    const record = this.deps.store.update({ paymentKey });
    this.confirming = this.sendConfirm(record, frozen, paymentKey).finally(() => { this.confirming = null; });
    return this.confirming;
  }

  private async sendConfirm(record: IntentRecord, body: ConfirmBody, paymentKey: string, probe = false): Promise<void> {
    const answer = await this.call("/v1/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": paymentKey },
      body: JSON.stringify(body),
    });
    if (this.disposed) return;
    const code = typeof answer.body.code === "string" ? answer.body.code : undefined;
    if (!answer.ok) {
      // 503 or no answer after send: the outcome is unknown. Keep key and body; a retry resends them.
      if (answer.status === 0 || answer.status >= 500) {
        // After a refresh the acceptance is not in memory. Today Commerce redacts a missing paid
        // acceptance to 503, so the probe cannot tell "never arrived" from "unavailable": show the
        // same quote for explicit acceptance; the stored payment key is kept and reused (R5).
        if (probe && answer.status >= 500) return this.preview("CONFIRM_AGAIN");
        return this.set({ phase: "UNAVAILABLE", code: "CONFIRM_OUTCOME_UNKNOWN", retryable: true, kind: this.kind });
      }
      this.deps.store.update({ paymentKey: undefined });
      this.frozenConfirm = null;
      if (probe && DOCUMENT_RENEW_CODES.has(code ?? "")) return this.preview("CONFIRM_AGAIN");
      return this.refusal(code ?? "CHECKOUT_UNAVAILABLE", answer, () => this.preview(DOCUMENT_RENEW_CODES.has(code ?? "") ? "DOCUMENTS_CHANGED" : "QUOTE_RENEWED"));
    }
    const orderPublicId = typeof answer.body.orderPublicId === "string" ? answer.body.orderPublicId : undefined;
    if (!orderPublicId) return this.set({ phase: "UNAVAILABLE", code: "CONFIRM_OUTCOME_UNKNOWN", retryable: true, kind: this.kind });
    this.deps.store.update({ orderPublicId });
    const status = normalizeStatus(answer.body, orderPublicId, record.kind ?? this.kind, this.deps.myOrigin);
    if (!status) return this.set({ phase: "UNAVAILABLE", code: "CONFIRM_OUTCOME_UNKNOWN", retryable: true, kind: this.kind });
    this.applied = acceptStatus(this.applied, ++this.statusSeq, status);
    if (this.applied.status.payment === "AWAITING_PAYMENT" && this.applied.status.paymentUrl) {
      this.set({ phase: "REDIRECTING", kind: this.kind });
      return this.deps.navigate(this.applied.status.paymentUrl);
    }
    this.showStatus();
    if (!TERMINAL.has(this.applied.status.payment)) await this.poll(orderPublicId);
  }

  /** Retry from an UNAVAILABLE state: resend the frozen confirm, or a new preview. */
  retry() {
    this.set({ phase: "LOADING" });
    return this.start();
  }

  private async refusal(code: string, answer: Answer, renew: () => Promise<void>, attempt = 0): Promise<void> {
    if (SIGN_IN_CODES.has(code) || answer.status === 401) return this.set({ phase: "SIGN_IN", href: this.signInHref });
    if (code === "LAB_ACCOUNT_CONFIRMATION_REQUIRED") return this.set({ phase: "ACCOUNT_CONFIRMATION", href: this.signInHref });
    if (code === "CONSENT_REQUIRED") return this.set({ phase: "CONSENT_REQUIRED", href: "/profile" });
    if (OWNED_CODES.has(code) && typeof answer.body.orderPublicId !== "string") {
      this.deps.store.clear();
      return this.set({ phase: "ALREADY_OWNED", kind: this.kind });
    }
    if (typeof answer.body.orderPublicId === "string" && (code === "CHECKOUT_PAYMENT_IN_PROGRESS" || OWNED_CODES.has(code))) {
      // An order of this account already holds the payment: read it, never start a second one.
      return this.observe(answer.body.orderPublicId, false);
    }
    if ((QUOTE_RENEW_CODES.has(code) || DOCUMENT_RENEW_CODES.has(code)) && attempt < 2) {
      this.deps.store.restartQuote();
      return renew();
    }
    this.set({ phase: "UNAVAILABLE", code, retryable: !UNAVAILABLE_FINAL.has(code), kind: this.kind });
  }

  /** Authoritative status read. A returned order is stored only once Commerce answers for it. */
  async observe(orderPublicId: string, stored: boolean): Promise<void> {
    const ok = await this.readStatus(orderPublicId, stored);
    if (ok && this.applied && !TERMINAL.has(this.applied.status.payment)) await this.poll(orderPublicId);
  }

  /** One status read; returns false when the flow left the status view. */
  async readStatus(orderPublicId: string, stored = true): Promise<boolean> {
    if (this.applied && this.applied.status.orderPublicId !== orderPublicId) this.applied = null;
    const seq = ++this.statusSeq;
    const answer = await this.call(`/v1/checkout/${encodeURIComponent(orderPublicId)}`);
    if (this.disposed) return false;
    if (answer.status === 401 || SIGN_IN_CODES.has(String(answer.body.code))) {
      if (!stored) this.deps.store.update({ orderPublicId });
      this.set({ phase: "SIGN_IN", href: this.signInHref });
      return false;
    }
    if (answer.status === 404) {
      const record = this.deps.store.load();
      if (record.orderPublicId === orderPublicId) this.deps.store.clear();
      this.pollGeneration += 1;
      this.set({ phase: "ORDER_NOT_FOUND" });
      return false;
    }
    if (!answer.ok) {
      // Timeout or unavailable read-back: keep the last authoritative status, keep polling.
      if (!this.applied) this.applied = { seq, status: { orderPublicId, payment: "CONFIRMING" } };
      this.showStatus("STATUS_DELAYED");
      return true;
    }
    const status = normalizeStatus(answer.body, orderPublicId, this.deps.store.load().kind ?? this.kind, this.deps.myOrigin);
    if (!status) return true;
    if (!stored && seq > (this.applied?.seq ?? 0)) this.deps.store.update({ orderPublicId, paymentKey: undefined });
    const before = this.applied;
    this.applied = acceptStatus(this.applied, seq, status);
    if (this.applied !== before || !before) this.showStatus();
    return true;
  }

  private showStatus(notice?: CheckoutNotice) {
    if (!this.applied) return;
    const polling = !TERMINAL.has(this.applied.status.payment);
    this.set({ phase: "STATUS", kind: this.kind, status: this.applied.status, polling, ...(notice ? { notice } : {}) });
  }

  private async poll(orderPublicId: string) {
    const generation = ++this.pollGeneration;
    for (let attempt = 0; attempt < (this.deps.pollAttempts ?? 15); attempt += 1) {
      await this.sleep(this.deps.pollIntervalMs ?? 2000);
      if (this.disposed || generation !== this.pollGeneration) return;
      const stillHere = await this.readStatus(orderPublicId);
      if (!stillHere || (this.applied && TERMINAL.has(this.applied.status.payment))) return;
    }
    if (this.applied && !this.disposed) this.set({ phase: "STATUS", kind: this.kind, status: this.applied.status, polling: false, notice: "STATUS_DELAYED" });
  }

  /** "Check again" in the status view. */
  refreshStatus() {
    const order = this.applied?.status.orderPublicId ?? this.deps.store.load().orderPublicId;
    return order ? this.observe(order, true) : this.start();
  }

  /** Back to the provider page Commerce issued for this order (AWAITING_PAYMENT only). */
  openPayment() {
    const url = this.applied?.status.payment === "AWAITING_PAYMENT" ? this.applied.status.paymentUrl : undefined;
    if (url) this.deps.navigate(url);
  }

  /** A declined or expired payment is never retried on the same order (C §3): a new quote and order. */
  startOver() {
    this.deps.store.clear();
    this.applied = null;
    this.pollGeneration += 1;
    this.set({ phase: "LOADING" });
    return this.preview();
  }
}
