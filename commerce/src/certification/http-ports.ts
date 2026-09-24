import { CertificationCapabilityError, type CertificationClaim } from "./capability";
import { CERTIFICATION_CLAIM_HEADER, encodeCertificationClaim } from "./checkout-admission";
import type { CertificationCatalogueCommand } from "./catalogue-authority";
import type { AdminPort, PublicPort } from "./machine";
import type { OccurrenceView, OrderEvidence } from "./evidence";
import type { OccurrenceDraft } from "./run";
import type { ReleaseReadinessEvidence } from "../release/readiness";

/**
 * The certification's two ports, over HTTP, to the runtime being certified.
 *
 * Not the local database, and not the runner's own code. The runner is deployed
 * from a checkout an operator maintains; it is not necessarily the target
 * commit, and a certification that drove the domain locally would be certifying
 * the runner rather than the container. Every action here crosses the network
 * to the thing under test.
 */

export class CertificationHttpError extends Error {
  constructor(readonly code: string, readonly status: number, detail?: string) {
    super(detail ? `${code} (${status}): ${detail}` : `${code} (${status})`);
  }
}

export type HttpOptions = {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
};

const json = async (response: Response, what: string): Promise<Record<string, unknown>> => {
  const text = await response.text();
  if (!response.ok) {
    // The body may carry a domain code worth reporting, and may equally be an
    // HTML error page. Neither is allowed to become the failure's identity, so
    // it is truncated and clearly marked as the server's words.
    throw new CertificationHttpError(`CERTIFICATION_${what}_FAILED`, response.status, text.slice(0, 200));
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CertificationHttpError(`CERTIFICATION_${what}_MALFORMED`, response.status);
  }
};

class Client {
  constructor(private readonly options: HttpOptions, private readonly token?: string) {}

  async call(method: string, path: string, what: string, body?: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const request: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        // The credential travels in a header. A query parameter lands in access
        // logs, proxy logs and browser history.
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.baseUrl}${path}`, request);
    } catch (error) {
      // The URL is deliberately absent: it carries the host, and for the public
      // client a path that identifies a live checkout.
      throw new CertificationHttpError(`CERTIFICATION_${what}_UNREACHABLE`, 0, error instanceof Error ? error.message : "unknown error");
    }
    return json(response, what);
  }
}

export class HttpCertificationAdminPort implements AdminPort {
  readonly #client: Client;

  constructor(options: HttpOptions & { readonly token: string; readonly runId: string }) {
    this.#client = new Client(options, options.token);
    this.#runId = options.runId;
  }

  readonly #runId: string;

  async systemEvidence(): Promise<ReleaseReadinessEvidence> {
    const body = await this.#client.call("GET", "/v1/certification/runtime", "RUNTIME");
    return body.evidence as ReleaseReadinessEvidence;
  }

  async cityIdBySlug(slug: string): Promise<string | undefined> {
    const body = await this.#client.call("GET", `/v1/certification/city?slug=${encodeURIComponent(slug)}`, "CITY");
    return typeof body.city_id === "string" ? body.city_id : undefined;
  }

  async runCatalogueCommand(runId: string, command: CertificationCatalogueCommand, body: Record<string, unknown>, reason: string): Promise<OccurrenceView> {
    void body;
    const response = await this.#client.call("POST", "/v1/certification/catalogue-command", "CATALOGUE_COMMAND", {
      run_id: runId, command_id: command.idempotencyKey, reason, claim: this.claimBody(),
      ...this.commandBody(command),
    });
    return response.occurrence as OccurrenceView;
  }

  /**
   * The command as the endpoint accepts it: named kind, typed fields, and
   * nothing free-form. `body` above is the machine's rendering of the same
   * intent for a route that took arbitrary payloads; this endpoint builds its
   * own, so it is ignored rather than forwarded.
   */
  private commandBody(command: CertificationCatalogueCommand): Record<string, unknown> {
    if (command.kind === "CREATE_OCCURRENCE") {
      return { kind: command.kind, draft: {
        city_id: command.draft.cityId, starts_at: command.draft.startsAt, ends_at: command.draft.endsAt,
        venue_disclosure_text: command.draft.venueDisclosureText, venue_announce_by: command.draft.venueAnnounceBy,
      } };
    }
    return { kind: command.kind, occurrence_id: command.occurrenceId, expected_revision: command.expectedRevision };
  }

  #claim?: CertificationClaim;
  /** Set once the capability exists; the catalogue endpoint proves possession too. */
  useClaim(claim: CertificationClaim) { this.#claim = claim; }
  private claimBody() {
    if (!this.#claim) throw new CertificationCapabilityError("CERTIFICATION_CLAIM_REQUIRED");
    return { capability_id: this.#claim.capabilityId, run_id: this.#claim.runId, nonce: this.#claim.nonce };
  }

  async occurrence(occurrenceId: string): Promise<OccurrenceView> {
    const body = await this.#client.call("GET", `/v1/certification/run/${encodeURIComponent(this.#runId)}/occurrence/${encodeURIComponent(occurrenceId)}`, "OCCURRENCE");
    return body.occurrence as OccurrenceView;
  }

  async occurrenceForCommand(idempotencyKey: string): Promise<OccurrenceView | undefined> {
    // Answered from the durable ledger by run, not by the caller's key: what
    // this run created is the question, the key is only how it was asked, and
    // the ledger is the only place that survived the response being lost.
    void idempotencyKey;
    const body = await this.#client.call("GET", `/v1/certification/run/${encodeURIComponent(this.#runId)}/occurrence`, "OCCURRENCE");
    return (body.occurrence as OccurrenceView | null) ?? undefined;
  }

  /**
   * Cleanup, expressed as the two named commands the endpoint admits.
   *
   * The occurrence and the revision are the server's: it derives them from what
   * this run created and from the catalogue as it is now. A close that could be
   * aimed by its caller is one that could be aimed at a real event.
   */
  async patchOccurrence(occurrenceId: string, patch: Record<string, unknown>, expectedRevision: number, reason: string, idempotencyKey: string): Promise<OccurrenceView> {
    void occurrenceId; void expectedRevision;
    const kind = patch.sales_status === "CLOSED" ? "CLOSE_SALES" : patch.visibility === "HIDDEN" ? "HIDE_OCCURRENCE" : undefined;
    if (!kind) throw new CertificationHttpError("CERTIFICATION_CLEANUP_PATCH_UNSUPPORTED", 400, JSON.stringify(patch));
    const response = await this.#client.call("POST", "/v1/certification/catalogue-command", "CATALOGUE_COMMAND", {
      run_id: this.#runId, command_id: idempotencyKey, reason, claim: this.claimBody(), kind,
    });
    return response.occurrence as OccurrenceView;
  }

  async occurrenceIsPubliclyVisible(occurrenceId: string): Promise<boolean> {
    const body = await this.#client.call("GET", `/v1/certification/run/${encodeURIComponent(this.#runId)}/occurrence/${encodeURIComponent(occurrenceId)}`, "OCCURRENCE");
    return body.publicly_visible === true;
  }

  async tourIncludes(occurrenceId: string): Promise<boolean> {
    const body = await this.#client.call("GET", `/v1/certification/run/${encodeURIComponent(this.#runId)}/occurrence/${encodeURIComponent(occurrenceId)}`, "OCCURRENCE");
    return body.in_tour === true;
  }

  async orderIdsForCheckoutStatus(statusId: string): Promise<readonly string[]> {
    const body = await this.#client.call("GET", `/v1/certification/run/${encodeURIComponent(this.#runId)}/orders?status_id=${encodeURIComponent(statusId)}`, "ORDERS");
    return Array.isArray(body.order_ids) ? (body.order_ids as string[]) : [];
  }

  async orderEvidence(orderId: string): Promise<OrderEvidence> {
    return await this.#client.call("GET", `/v1/certification/run/${encodeURIComponent(this.#runId)}/order/${encodeURIComponent(orderId)}/evidence`, "ORDER_EVIDENCE") as OrderEvidence;
  }

  async cancelBookingCustomerInitiated(bookingId: string, idempotencyKey: string): Promise<void> {
    await this.#client.call("POST", `/v1/certification/run/${encodeURIComponent(this.#runId)}/cancel-booking`, "CANCELLATION", {
      booking_id: bookingId, idempotency_key: idempotencyKey,
    });
  }
}

/**
 * The public surface, reached exactly as a customer reaches it - no service
 * credential, no privileged route. The only difference is the claim header,
 * which is what a certification is.
 */
export class HttpCertificationPublicPort implements PublicPort {
  readonly #client: Client;

  constructor(options: HttpOptions) {
    this.#client = new Client(options);
  }

  async checkoutContext(occurrenceId: string, claim: CertificationClaim): Promise<{ quoteId: string }> {
    // The fence is closed by this release; the claim is what lets its own
    // certification quote its own fixture behind it.
    const body = await this.#client.call("POST", "/v1/public/checkout-context", "CHECKOUT_CONTEXT", { occurrence_id: occurrenceId }, {
      [CERTIFICATION_CLAIM_HEADER]: encodeCertificationClaim(claim),
    });
    const quoteId = body.quote_id;
    if (typeof quoteId !== "string" || !quoteId) throw new CertificationHttpError("CERTIFICATION_QUOTE_MALFORMED", 200);
    return { quoteId };
  }

  async createCheckout(body: string, idempotencyKey: string, claim: CertificationClaim): Promise<{ statusId: string; paymentUrl?: string }> {
    const response = await this.#client.call("POST", "/v1/public/checkouts", "CHECKOUT", JSON.parse(body) as Record<string, unknown>, {
      "Idempotency-Key": idempotencyKey,
      // Never a query parameter: this one opens a fence.
      [CERTIFICATION_CLAIM_HEADER]: encodeCertificationClaim(claim),
    });
    const statusId = response.status_id;
    if (typeof statusId !== "string" || !statusId) throw new CertificationHttpError("CERTIFICATION_CHECKOUT_MALFORMED", 200);
    return { statusId, paymentUrl: typeof response.payment_url === "string" ? response.payment_url : undefined };
  }

  async checkoutStatus(statusId: string): Promise<{ status: string }> {
    const body = await this.#client.call("GET", `/v1/public/checkout-status/${encodeURIComponent(statusId)}`, "CHECKOUT_STATUS");
    return { status: String(body.status ?? "") };
  }
}

export type OccurrenceScope = Omit<OccurrenceDraft, "cityId">;
