import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api";
import { migrate, openDatabase } from "../../src/db";
import { CommerceDomain } from "../../src/domain";
import { UnisenderGoProvider } from "../../src/email-provider";
import { TochkaProvider } from "../../src/provider";
import { ProductionCertificationDriver } from "../../src/certification/driver";
import { SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import { activeLegalBinding } from "../../src/release/legal-binding";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { runWorkerCycle } from "../../src/worker-cycle";
import { TEST_CAPABILITY_KEY } from "../support/certification-secret";

/**
 * A production certification, end to end, against the real commerce runtime.
 *
 * Attempt 5 and its retry each failed on a contract between the runner and
 * the deployed runtime that no test had ever exercised: first the armed
 * command's key order, then an identity field the create response does not
 * carry. Both sides had tests, and the tests on each side described the other
 * side by hand - including one written to fix the first failure, which invented
 * the field whose absence caused the second.
 *
 * So nothing here describes the runtime. The runner is the real certification
 * driver and machine with its real HTTP ports; every request they make is
 * served by `createApp` - the real Hono app, the real certification service
 * router, the real public checkout routes, the real domain - over the real
 * request and response serialization. The worker cycle is the real one.
 *
 * The only substitutes are the two systems outside production: the payment
 * provider and the email provider. They are the real adapter classes with
 * their network replaced, because the runtime mounts its webhook routes only
 * for those classes - and the evidence certification demands is what those
 * webhooks write. The webhooks themselves are signed exactly as the providers
 * sign them and verified by the runtime's own verifiers.
 */

type PaymentCreateInput = Parameters<TochkaProvider["createPayment"]>[0];

const SHA = "e".repeat(40);
const SESSION = "e4cb1a91-5e8a-4e2b-8b40-9e8fbcadb557";
const SERVICE_TOKEN = "certification-service-token-for-tests";
const UNISENDER_KEY = "unisender-key-for-tests";
const TOCHKA_JWK_URL = "https://enter.tochka.com/doc/openapi/static/keys/public";
const API = "http://api.flexperiment.ru";

/** The payment provider, with the network replaced and nothing else. */
class OutsideTochka extends TochkaProvider {
  readonly created: PaymentCreateInput[] = [];
  readonly refunded: { refundId: string; providerPaymentId: string; amountKopecks: number }[] = [];
  override async probe() { return { environment: "sandbox" as const }; }
  override async createPayment(input: PaymentCreateInput) {
    this.created.push(input);
    return { providerPaymentId: `tochka-${input.paymentId}`, paymentUrl: `https://pay.tochka.invalid/${input.paymentId}` };
  }
  override async findPaymentOperationsByLinkId() { return []; }
  override async refund(input: { refundId: string; providerPaymentId: string; amountKopecks: number; idempotencyKey: string }) {
    this.refunded.push(input);
    return { providerReference: `tochka-refund-${input.refundId}` };
  }
  override async reconcilePayment() { return { status: "PENDING" as const }; }
  override async reconcileRefund(input: { amountKopecks: number }) {
    return { status: "SUCCEEDED" as const, refundedAmountKopecks: input.amountKopecks };
  }
}

/** The email provider, with the network replaced and nothing else. */
class OutsideUnisender extends UnisenderGoProvider {
  readonly sent: { outboxId?: string; jobId: string; type?: string }[] = [];
  override async send(input: { idempotencyKey: string; outboxId?: string; type?: string }) {
    const jobId = `job-${input.idempotencyKey}`;
    this.sent.push({ outboxId: input.outboxId, jobId, type: input.type });
    return { jobId };
  }
  override async lookup() { return { status: "ACCEPTED" as const }; }
}

const env: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string) => { if (!(name in env)) env[name] = process.env[name]; process.env[name] = value; };

let tochkaKey: KeyObject;

beforeEach(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  tochkaKey = privateKey;
  const jwk = publicKey.export({ format: "jwk" });
  // The runtime's own Tochka verifier fetches the provider's public key; here
  // that is the one outside request it makes, and it gets the test key.
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    if (String(input) === TOCHKA_JWK_URL) return Response.json(jwk);
    throw new Error(`UNEXPECTED_OUTSIDE_REQUEST: ${String(input)}`);
  });
  setEnv("SOURCE_COMMIT", SHA);
  setEnv("COMMERCE_CERTIFICATION_TOKEN_SHA256", createHash("sha256").update(SERVICE_TOKEN).digest("hex"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  for (const name of Object.keys(env)) delete env[name];
});

/**
 * `withhold`: email types the recipient's server keeps deferring - the provider
 * reports them sent, never delivered. `emailMs` shortens the wait so a test can
 * reach its end.
 */
const production = (options: { withhold?: readonly string[]; emailMs?: number } = {}) => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'moscow', 'Москва')").run(randomUUID());
  // Production's own legal manifest, as the launch publishes it.
  const manifest = readFileSync("commerce/legal/production-manifest.json", "utf8");
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, ?, datetime('now'), ?, 1)")
    .run(randomUUID(), String((JSON.parse(manifest) as { version: string }).version), manifest);
  db.prepare("UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1 WHERE singleton = 1").run();
  // Attempt 5's session: armed, fenced, in recovery, for this release.
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, observed_topology, created_at, lease_expires_at, deployment_gate_closed, mutation_observed)
    VALUES (?, 'operator', 'MAINTENANCE_CUTOVER', ?, ?, 'RECOVERY_REQUIRED', 'NEW_LINEAGE_ONLY', ?, ?, datetime('now'), datetime('now'), 1, 1)`).run(
    SESSION, SHA, SHA,
    JSON.stringify({ runtime: { frontend: "b".repeat(40), admin: "b".repeat(40), commerce: "b".repeat(40), worker: "b".repeat(40) }, controlPlane: { productionDeployRefSha: "b".repeat(40) } }),
    JSON.stringify({ runtime: { frontend: SHA, admin: SHA, commerce: SHA, worker: SHA }, controlPlane: { productionDeployRefSha: SHA } }),
  );

  const tochka = new OutsideTochka({
    baseUrl: "https://enter.tochka.com/uapi", jwt: "not-a-token", customerCode: "300000000", merchantId: "200000000000000",
    taxSystemCode: "usn_income", vatType: "none",
  });
  const unisender = new OutsideUnisender({ apiKey: UNISENDER_KEY, fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" });
  const app = createApp(db, tochka, unisender);
  // The worker is its own process in production, with its own domain over the
  // same database.
  const worker = new CommerceDomain(db, tochka, unisender);

  const beat = () => {
    const now = new Date().toISOString();
    db.prepare("DELETE FROM runtime_instance_evidence").run();
    for (const unit of ["COMMERCE", "WORKER"]) {
      db.prepare(`INSERT INTO runtime_instance_evidence(instance_id, unit, source_commit, started_at, heartbeat_at, last_successful_sweep_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(`${unit}-1`, unit, SHA, now, now, now);
    }
  };
  beat();

  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((row) => row.version);
  const legal = activeLegalBinding(db)!;
  const candidate: ReleaseCandidate = {
    id: SHA, sha: SHA, releaseClass: "MAINTENANCE_REQUIRED",
    expectation: { schemaInventory: schemaInventoryExpectation(versions), legalVersion: legal.version, legalManifestSha256: legal.manifestSha256 },
  };

  // What the payer and the providers do, between the runner's looks.
  const paid = new Set<string>();
  const delivered = new Set<string>();
  const outside = async () => {
    for (const payment of tochka.created) {
      if (!payer.approved || paid.has(payment.paymentId)) continue;
      paid.add(payment.paymentId);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({
        operationId: `operation-${payment.paymentId}`, paymentLinkId: payment.paymentLinkId, amount: (payment.amountKopecks / 100).toFixed(2),
        customerCode: "300000000", merchantId: "200000000000000", paymentType: "card", status: "APPROVED",
        webhookType: "acquiringInternetPayment", currency: "RUB",
      })).toString("base64url");
      const jwt = `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), tochkaKey).toString("base64url")}`;
      const response = await app.request(`${API}/v1/webhooks/tochka`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Forwarded-For": "127.0.0.1" }, body: jwt });
      if (response.status !== 200) throw new Error(`TOCHKA_WEBHOOK_REFUSED ${response.status} ${await response.text()}`);
    }
    await runWorkerCycle({ domain: worker, db, collectProviderDrift: false });
    for (const email of unisender.sent) {
      if (!email.outboxId || delivered.has(email.jobId)) continue;
      delivered.add(email.jobId);
      const status = options.withhold?.includes(email.type ?? "") ? "sent" : "delivered";
      const unsigned = JSON.stringify({ auth: "pending", events_by_user: [{ user_id: 1, events: [{ event_name: "transactional_email_status",
        event_data: { job_id: email.jobId, metadata: { outbox_id: email.outboxId }, status, event_time: "2026-09-24 04:00:00" } }] }] });
      const body = unsigned.replace("pending", createHash("md5").update(unsigned.replace("pending", UNISENDER_KEY)).digest("hex"));
      const response = await app.request(`${API}/v1/webhooks/unisender`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body });
      if (response.status !== 200) throw new Error(`UNISENDER_WEBHOOK_REFUSED ${response.status} ${await response.text()}`);
    }
    beat();
  };

  // The person at the terminal: pays when shown the page, confirms the ticket.
  const payer = { approved: false, lines: [] as string[] };
  const terminal = {
    write(line: string) {
      payer.lines.push(line);
      if (line.includes("https://pay.tochka.invalid/")) payer.approved = true;
    },
    readLine: () => "yes",
    close() {},
  };

  const scopeDirectory = mkdtempSync(join(tmpdir(), "certification-e2e-"));
  const checkoutBodyPath = join(scopeDirectory, "checkout.json");
  writeFileSync(checkoutBodyPath, JSON.stringify({
    customer_email: "certification@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT",
    offer_accepted: true, pd_consent_accepted: true,
  }));

  // Every runner request is served by the real app. Before each one the
  // outside world gets a turn, which is what a poll interval is.
  const requests: string[] = [];
  const runnerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    await outside();
    return app.request(String(input), init);
  }) as typeof globalThis.fetch;

  const driver = new ProductionCertificationDriver({
    db, candidate,
    adminBaseUrl: API, publicBaseUrl: API, serviceToken: SERVICE_TOKEN, capabilityKey: TEST_CAPABILITY_KEY,
    citySlug: "moscow",
    operator: {
      occurrence: {
        startsAt: "2026-12-15T15:00:00.000Z", endsAt: "2026-12-15T18:00:00.000Z",
        venueDisclosureText: "Точный адрес площадки сообщим участникам по электронной почте.", venueAnnounceBy: "2026-12-08T09:00:00.000Z",
      },
      checkoutBodyPath,
    },
    terminal: () => terminal,
    fetch: runnerFetch,
    timeouts: { paymentMs: 60_000, emailMs: options.emailMs ?? 60_000, refundMs: 60_000 },
  });

  return { db, app, tochka, unisender, driver, requests, payer };
};

describe("a production certification against the real commerce runtime", () => {
  it("fails an undelivered ticket at the limit, and says what it saw", async () => {
    // The recipient's server defers the ticket: the provider reports it sent,
    // never delivered. The limit fails the certification as before; the
    // failure now carries what the wait observed - and nothing personal.
    const world = production({ withhold: ["TICKET"], emailMs: 1 });
    const capability = await world.driver.issueCapability(SESSION);
    await world.driver.preflight(capability);

    const failure = await world.driver.certify(capability).then(() => undefined, (error: Error) => error.message);
    expect(failure).toMatch(/^INCOMPLETE:CERTIFICATION_EMAIL_TIMEOUT:TICKET last_status=SENT last_provider=sent@\S+ provider_events=\d+ queued_at=\S+ first_sent_at=\S+ waited=\d+m\d{2}s observed_at=\S+ delivery_status=\w+ evidence_source=\w+ destination_response=(UNAVAILABLE|"[^"]*")$/);
    expect(failure).not.toContain("certification@example.test");
    const run = new SqliteCertificationRunStore(world.db).load(capability.runId)!;
    expect(run.failure?.code).toMatch(/^CERTIFICATION_EMAIL_TIMEOUT:TICKET last_status=SENT /);
    world.db.close();
  });

  it("runs from CREATE_OCCURRENCE to COMPLETE through every real route", async () => {
    const world = production();
    const capability = await world.driver.issueCapability(SESSION);
    await world.driver.preflight(capability);

    await world.driver.certify(capability);

    const run = new SqliteCertificationRunStore(world.db).load(capability.runId)!;
    expect(run).toMatchObject({ phase: "COMPLETE", failure: null, direction: "CATALOGUE_CLEAN" });
    // One payment and one refund, for the certification price, at the provider.
    expect(world.tochka.created.map((payment) => payment.amountKopecks)).toEqual([100]);
    expect(world.tochka.refunded.map((refund) => refund.amountKopecks)).toEqual([100]);
    // The fixture ends closed and hidden.
    expect(world.db.prepare("SELECT sales_status, visibility FROM occurrences").all()).toEqual([{ sales_status: "CLOSED", visibility: "HIDDEN" }]);
    world.db.close();
  });
});
