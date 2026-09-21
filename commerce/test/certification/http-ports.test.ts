import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CertificationHttpError, HttpCertificationAdminPort, HttpCertificationPublicPort } from "../../src/certification/http-ports";

/**
 * Against a real HTTP server, because the thing under test is what crosses the
 * network: the header a claim travels in, the credential the service routes
 * require, and the run every scoped read is bound to.
 */

type Call = { method: string; url: string; headers: Record<string, string | undefined>; body: string };

let server: Server;
let baseUrl: string;
let calls: Call[];
let reply: (call: Call) => { status?: number; body: unknown };

beforeEach(async () => {
  calls = [];
  reply = () => ({ body: {} });
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const call: Call = { method: request.method ?? "", url: request.url ?? "", headers: request.headers as Record<string, string | undefined>, body };
      calls.push(call);
      const answer = reply(call);
      response.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const claim = { capabilityId: "cap-1", runId: "run-1", nonce: "nonce-1" };
const admin = () => {
  const port = new HttpCertificationAdminPort({ baseUrl, token: "service-token", runId: "run-1" });
  port.useClaim(claim);
  return port;
};

describe("the public surface a certification buys through", () => {
  it("sends the claim as a header and never as a query parameter", async () => {
    reply = () => ({ body: { status_id: "status-1", payment_url: "https://provider.invalid/pay" } });
    const result = await new HttpCertificationPublicPort({ baseUrl })
      .createCheckout(JSON.stringify({ quote_id: "quote" }), "idempotency-key-0001", claim);

    expect(result).toEqual({ statusId: "status-1", paymentUrl: "https://provider.invalid/pay" });
    const [call] = calls;
    expect(call.url).toBe("/v1/public/checkouts");
    expect(call.headers["x-certification-claim"]).toBe("cap-1.run-1.nonce-1");
    expect(call.headers["idempotency-key"]).toBe("idempotency-key-0001");
    // A query parameter lands in access logs, proxy logs and browser history.
    expect(call.url).not.toContain("cap-1");
  });

  it("carries no service credential at all", async () => {
    // It reaches the shop the way a customer does. A privileged route or a
    // token here would mean the certification proved a path nobody else takes.
    reply = () => ({ body: { quote_id: "quote-1" } });
    await new HttpCertificationPublicPort({ baseUrl }).checkoutContext("occ");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].url).toBe("/v1/public/checkout-context");
  });

  it("uses the same idempotency key on a repeat, so a timeout cannot buy twice", async () => {
    reply = () => ({ body: { status_id: "status-1" } });
    const port = new HttpCertificationPublicPort({ baseUrl });
    await port.createCheckout(JSON.stringify({ quote_id: "quote" }), "idempotency-key-0001", claim);
    await port.createCheckout(JSON.stringify({ quote_id: "quote" }), "idempotency-key-0001", claim);
    expect(calls.map((call) => call.headers["idempotency-key"])).toEqual(["idempotency-key-0001", "idempotency-key-0001"]);
  });

  it("refuses a checkout the server answered with something else", async () => {
    reply = () => ({ body: { note: "no status" } });
    await expect(new HttpCertificationPublicPort({ baseUrl }).createCheckout("{}", "key", claim))
      .rejects.toThrow("CERTIFICATION_CHECKOUT_MALFORMED");
  });
});

describe("the service surface a certification administers through", () => {
  it("presents the machine credential as a bearer token", async () => {
    reply = () => ({ body: { evidence: { schema: { lineage: "SUPPORTED", versions: [] } } } });
    await admin().systemEvidence();
    expect(calls[0].headers.authorization).toBe("Bearer service-token");
    expect(calls[0].url).toBe("/v1/certification/runtime");
  });

  it("scopes every read to its own run", async () => {
    reply = () => ({ body: { occurrence: { id: "occ" }, publicly_visible: false, in_tour: false, order_ids: [] } });
    const port = admin();
    await port.occurrence("occ");
    await port.orderIdsForCheckoutStatus("status-1");
    await port.orderEvidence("order-1");
    // A credential that could read any order or any event by id would be an
    // admin credential with extra steps.
    for (const call of calls) expect(call.url).toContain("/run/run-1/");
  });

  it("asks the ledger what its create command produced, not a key it kept", async () => {
    reply = () => ({ body: { occurrence: { id: "occ" } } });
    expect(await admin().occurrenceForCommand("whatever-key")).toEqual({ id: "occ" });
    expect(calls[0].url).toBe("/v1/certification/run/run-1/occurrence");
  });

  it("sends a typed command rather than a forwarded payload", async () => {
    reply = () => ({ body: { occurrence: { id: "occ" } } });
    await admin().runCatalogueCommand("run-1", {
      kind: "CREATE_OCCURRENCE", idempotencyKey: "command-1",
      draft: { cityId: "city", startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z", venueDisclosureText: "Later", venueAnnounceBy: "2026-09-25T00:00:00.000Z" },
    }, { capacity: 5000, price_kopecks: 1 }, "Production E2E certification");

    const sent = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(sent).toMatchObject({ run_id: "run-1", command_id: "command-1", kind: "CREATE_OCCURRENCE" });
    // The machine's free-form rendering is ignored, never forwarded: the
    // endpoint builds its own body.
    expect(calls[0].body).not.toContain("5000");
  });

  it("turns cleanup into the two named commands and lets the server aim them", async () => {
    reply = () => ({ body: { occurrence: { id: "occ" } } });
    const port = admin();
    await port.patchOccurrence("occ", { sales_status: "CLOSED" }, 7, "reason", "close-key");
    await port.patchOccurrence("occ", { visibility: "HIDDEN" }, 8, "reason", "hide-key");

    expect(calls.map((call) => (JSON.parse(call.body) as { kind: string }).kind)).toEqual(["CLOSE_SALES", "HIDE_OCCURRENCE"]);
    // The occurrence and the revision are the server's: a close that could be
    // aimed by its caller is one that could be aimed at a real event.
    for (const call of calls) {
      expect(call.body).not.toContain("occurrence_id");
      expect(call.body).not.toContain("expected_revision");
    }
  });

  it("refuses a cleanup patch it has no command for", async () => {
    await expect(admin().patchOccurrence("occ", { capacity: 99 }, 1, "reason", "key"))
      .rejects.toThrow("CERTIFICATION_CLEANUP_PATCH_UNSUPPORTED");
    expect(calls).toEqual([]);
  });

  it("refuses to act before it holds a claim", async () => {
    const port = new HttpCertificationAdminPort({ baseUrl, token: "service-token", runId: "run-1" });
    await expect(port.patchOccurrence("occ", { sales_status: "CLOSED" }, 1, "reason", "key"))
      .rejects.toThrow("CERTIFICATION_CLAIM_REQUIRED");
  });

  it("reports a refusal without making the server's words the failure", async () => {
    reply = () => ({ status: 409, body: { error: "CERTIFICATION_CATALOGUE_OUT_OF_ORDER" } });
    await expect(admin().systemEvidence()).rejects.toThrow(CertificationHttpError);
    await expect(admin().systemEvidence()).rejects.toThrow("CERTIFICATION_RUNTIME_FAILED (409)");
  });

  it("does not put the address in an unreachable error", async () => {
    // The base URL carries the host, and for the public client a path that
    // identifies a live checkout.
    const port = new HttpCertificationAdminPort({ baseUrl: "http://127.0.0.1:1/", token: "t", runId: "run-1" });
    await expect(port.systemEvidence()).rejects.toThrow("CERTIFICATION_RUNTIME_UNREACHABLE");
  });
});
