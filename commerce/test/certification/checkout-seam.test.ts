import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommerceDomain, DomainError } from "../../src/domain";
import { MockProvider } from "../../src/provider";
import { issueCapability } from "../../src/certification/capability";
import { admitCertificationCheckout, parseCertificationClaim } from "../../src/certification/checkout-admission";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import { concurrencyFixture, type ConcurrencyFixture } from "../support/concurrency-fixture";
import { testSecret } from "../support/certification-secret";

/**
 * The seam that did not exist: a recorded deployment fence that nothing in the
 * public checkout consulted, and no way for a certification to pass it.
 *
 * These are the cases that were passing before only because nobody asked. The
 * fence is asserted through `assertNewOrdersOpen`, which is the boundary a
 * customer actually reaches.
 */

const SHA = "a".repeat(40);
const SESSION = "deploy-session";
const now = new Date("2026-09-20T12:00:00.000Z");

const fixtures: ConcurrencyFixture[] = [];
// The runtime's own commit is one of the facts the gate compares against, and
// a runtime that cannot say what it is has nothing to certify.
const sourceCommit = process.env.SOURCE_COMMIT;
beforeEach(() => { process.env.SOURCE_COMMIT = SHA; });
afterEach(() => {
  if (sourceCommit === undefined) delete process.env.SOURCE_COMMIT; else process.env.SOURCE_COMMIT = sourceCommit;
  while (fixtures.length) fixtures.pop()?.close();
});

const setup = () => {
  const fixture = concurrencyFixture();
  fixtures.push(fixture);
  const db = fixture.primary;
  db.prepare("UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1 WHERE singleton = 1").run();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city', 'test-city', 'Test City')").run();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      venue_status, venue_disclosure_text, venue_announce_by, visibility, sales_status)
    VALUES ('occ', 'city', 'Certification', '2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', 'Europe/Moscow', 100, 1,
      'TO_BE_ANNOUNCED', 'Announced later', '2026-09-25T00:00:00.000Z', 'PUBLISHED', 'OPEN')`).run();
  db.prepare(`INSERT INTO legal_releases(id, version, effective_at, manifest_json, active)
    VALUES ('legal', '2026-09-20.1', '2026-09-20T00:00:00.000Z', '{"documents":{}}', 1)`).run();
  db.prepare(`INSERT INTO quotes(id, occurrence_id, material_revision, legal_release_id, price_kopecks,
      discount_kopecks, final_amount_kopecks, venue_disclosure, expires_at)
    VALUES ('quote', 'occ', 1, 'legal', 100, 0, 100, 'Announced later', '2099-01-01T00:00:00.000Z')`).run();
  return { fixture, db, domain: new CommerceDomain(db, new MockProvider()) };
};

const session = (db: ConcurrencyFixture["primary"], id: string, state: string, gateClosed: 0 | 1) =>
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, ?, ?, 'NEW_LINEAGE_ONLY',
      '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
      '2026-09-19T00:00:00.000Z', '2099-01-01T00:00:00.000Z', ?)`).run(id, SHA, SHA, state, gateClosed);

const closeFence = (db: ConcurrencyFixture["primary"], sessionId = SESSION) => session(db, sessionId, "DEPLOYING", 1);

const armRun = (db: ConcurrencyFixture["primary"]) => {
  const runs = new SqliteCertificationRunStore(db);
  runs.create({
    runId: "run", revision: 1, releaseSha: SHA, phase: "CHECKOUT_SUBMITTING", direction: "FINANCIAL_EFFECT_POSSIBLE",
    startedAt: now.toISOString(), occurrenceId: "occ", quoteId: "quote",
  });
  return issueCapability(new SqliteCertificationCapabilityStore(db),
    { runId: "run", deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: 300_000 }, now, testSecret());
};

const refusal = (run: () => unknown): string => {
  try { run(); return "OPEN"; } catch (error) { return error instanceof DomainError ? error.code : String(error); }
};

describe("the deployment fence and the public checkout are one fact", () => {
  it("closes sales while a maintenance session holds the fence", () => {
    const { db, domain } = setup();
    expect(refusal(() => domain.assertNewOrdersOpen())).toBe("OPEN");
    expect(domain.newOrdersBlocked()).toBe(false);

    closeFence(db);

    // Before this seam the session recorded a closed fence and a customer
    // could still buy: the record said one thing and the shop did another.
    expect(refusal(() => domain.assertNewOrdersOpen())).toBe("SALES_TEMPORARILY_PAUSED");
    expect(domain.newOrdersBlocked()).toBe(true);
  });

  it("keeps the emergency stop above any capability", () => {
    const { db, domain } = setup();
    closeFence(db);
    const { capability, nonce } = armRun(db);
    db.prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1").run();

    // A capability that could pass this would turn the operator's last manual
    // stop into an advisory one.
    expect(refusal(() => admitCertificationCheckout(db, { capabilityId: capability.id, runId: "run", nonce },
      "quote", "idempotency-key-0001", now, () => ({ status_id: "s" }))))
      .not.toBe("OPEN");
    expect(domain.emergencySalesPaused()).toBe(true);
  });

  it("admits a scoped capability through the fence the release itself closed", () => {
    const { db } = setup();
    closeFence(db);
    const { capability, nonce } = armRun(db);

    const admitted = admitCertificationCheckout(db, { capabilityId: capability.id, runId: "run", nonce },
      "quote", "idempotency-key-0001", now, (certification) => {
        // The gate is asked with the capability, from inside the transaction.
        expect(certification.run.runId).toBe("run");
        expect(certification.deploymentSessionId).toBe(SESSION);
        return { status_id: "status" };
      });

    expect(admitted).toEqual({ kind: "CREATED", result: { status_id: "status" } });
    expect(new SqliteCertificationCapabilityStore(db).get(capability.id)?.consumedAt).toBe(now.toISOString());
  });

  it("refuses a capability scoped to another fence, another release or another price", () => {
    const { db } = setup();
    // The capability's own session is settled; the live fence belongs to
    // another one. A capability that could open whichever fence happens to be
    // shut is not scoped to anything.
    session(db, SESSION, "SUCCEEDED", 0);
    closeFence(db, "another-session");
    const { capability, nonce } = armRun(db);
    const claim = { capabilityId: capability.id, runId: "run", nonce };

    expect(() => admitCertificationCheckout(db, claim, "quote", "idempotency-key-0001", now, () => ({ status_id: "s" })))
      .toThrow(/CERTIFICATION_CAPABILITY_SESSION_MISMATCH|CERTIFICATION_CONTEXT_SESSION_MISMATCH/);
    expect(new SqliteCertificationCapabilityStore(db).get(capability.id)?.consumedAt).toBeNull();
  });

  it("refuses a nonce that does not match, without spending the capability", () => {
    const { db } = setup();
    closeFence(db);
    const { capability, nonce } = armRun(db);

    expect(() => admitCertificationCheckout(db, { capabilityId: capability.id, runId: "run", nonce: "wrong-nonce" },
      "quote", "idempotency-key-0001", now, () => ({ status_id: "s" }))).toThrow();
    expect(new SqliteCertificationCapabilityStore(db).get(capability.id)?.consumedAt).toBeNull();
  });
});

describe("how a claim may reach the server", () => {
  it("reads three opaque fields, and refuses anything else by shape", () => {
    expect(parseCertificationClaim("cap.run.nonce")).toEqual({ capabilityId: "cap", runId: "run", nonce: "nonce" });
    expect(parseCertificationClaim(undefined)).toBeUndefined();
    expect(parseCertificationClaim("   ")).toBeUndefined();
    for (const malformed of ["cap.run", "cap.run.nonce.extra", "cap..nonce", "cap.run.no nce", "../../etc"]) {
      expect(() => parseCertificationClaim(malformed)).toThrow("CERTIFICATION_CLAIM_MALFORMED");
    }
  });

  it("is read from a header, never from the query string", () => {
    // A query parameter lands in access logs, proxy logs and browser history,
    // and this one is the difference between an open fence and a closed one.
    const route = readFileSync("commerce/src/api.ts", "utf8");
    const checkout = route.slice(route.indexOf('publicApi.post("/checkouts"'), route.indexOf('publicApi.get("/checkout-status'));
    expect(checkout).toContain("c.req.header(CERTIFICATION_CLAIM_HEADER)");
    expect(checkout).not.toMatch(/c\.req\.query\(/);
  });
});

describe("a certification fixture is never an ordinary purchase", () => {
  /** A finished cutover: the capability's session exists, and no fence is held. */
  const settled = (db: ConcurrencyFixture["primary"]) => session(db, SESSION, "SUCCEEDED", 0);

  const ledgerRow = (db: ConcurrencyFixture["primary"], kind = "CREATE_OCCURRENCE", occurrenceId = "occ") =>
    db.prepare(`INSERT INTO certification_catalogue_mutations(run_id, command_kind, command_id, occurrence_id, occurrence_json)
      VALUES ('run', ?, ?, ?, '{"id":"occ"}')`).run(kind, `command-${kind}`, occurrenceId);

  const order = (db: ConcurrencyFixture["primary"], occurrenceId: string, runId: string | null, id = "order-1") =>
    db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email,
        customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot,
        checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, resolution_reason, certification_run_id)
      VALUES (?, ?, ?, ?, 'Customer', 'customer@example.invalid', 'hash', 100, 1, 'TBA',
        'legal', '{}', '2026-09-19T00:00:00.000Z', 'DIRECT', ?)`)
      .run(id, `status-${id}`, `FX-${id}`, occurrenceId, runId);

  it("refuses an ordinary checkout of it even with every gate wide open", () => {
    const { db, domain } = setup();
    settled(db);
    armRun(db);
    ledgerRow(db);

    // Both ordinary gates are open: no fence, no emergency stop. Hiding it from
    // the catalogue and having an unguessable id are not protections once the
    // deployment gate lifts, so the ban sits below every gate and every route.
    expect(refusal(() => domain.assertNewOrdersOpen())).toBe("OPEN");
    expect(() => order(db, "occ", null)).toThrow("CERTIFICATION_OCCURRENCE_REQUIRES_CLAIM");
  });

  it("still admits an ordinary checkout of an ordinary occurrence", () => {
    const { db } = setup();
    settled(db);
    armRun(db);
    ledgerRow(db);
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
        venue_status, venue_disclosure_text, venue_announce_by, visibility, sales_status)
      VALUES ('real', 'city', 'A real workshop', '2026-11-01T10:00:00.000Z', '2026-11-01T12:00:00.000Z', 'Europe/Moscow', 100, 1,
        'TO_BE_ANNOUNCED', 'Later', '2026-10-25T00:00:00.000Z', 'PUBLISHED', 'OPEN')`).run();

    expect(() => order(db, "real", null)).not.toThrow();
  });

  it("refuses one run collecting another run's fixture", () => {
    const { db } = setup();
    settled(db);
    armRun(db);
    ledgerRow(db);
    new SqliteCertificationRunStore(db).create({
      runId: "other", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt: now.toISOString(),
    });
    expect(() => order(db, "occ", "other")).toThrow("CERTIFICATION_ORDER_OCCURRENCE_MISMATCH");
  });

  it("will not let a release succeed while its fixture is still for sale", () => {
    // completeTarget settles the session and reopens public sales in one
    // operation, so an occurrence left OPEN at that moment becomes an ordinary
    // sellable event the instant the fence lifts.
    const { db } = setup();
    closeFence(db);
    armRun(db);
    ledgerRow(db);

    const succeed = () => db.prepare("UPDATE deploy_sessions SET state = 'SUCCEEDED', deployment_gate_closed = 0 WHERE id = ?").run(SESSION);
    expect(succeed).toThrow("CERTIFICATION_CATALOGUE_STILL_OPEN");

    db.prepare("UPDATE occurrences SET sales_status = 'CLOSED', visibility = 'HIDDEN' WHERE id = 'occ'").run();
    expect(succeed).not.toThrow();
  });

  it("reconciles a repeated close rather than recording a second one", () => {
    const { db } = setup();
    settled(db);
    armRun(db);
    ledgerRow(db);
    ledgerRow(db, "CLOSE_SALES");

    // `(run_id, kind)` is the identity, so a second close under any key is the
    // same close.
    expect(() => ledgerRow(db, "CLOSE_SALES")).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_catalogue_mutations WHERE run_id = 'run'").get())
      .toEqual({ n: 2 });
  });

  it("keeps the run recoverable between the refund and the close", () => {
    // Restart after the refund: the run, its ledger and the checkout
    // idempotency all survive, so a new process continues the same run rather
    // than starting one.
    const { fixture, db } = setup();
    settled(db);
    armRun(db);
    ledgerRow(db);
    const runs = new SqliteCertificationRunStore(db);
    runs.update("run", 1, { phase: "REFUND_EMAIL_DELIVERED", direction: "CLEANUP_STARTED" });

    const reopened = fixture.restart();
    const after = new SqliteCertificationRunStore(reopened).load("run");
    expect(after).toMatchObject({ runId: "run", phase: "REFUND_EMAIL_DELIVERED", direction: "CLEANUP_STARTED" });
    expect(reopened.prepare("SELECT command_kind FROM certification_catalogue_mutations WHERE run_id = 'run'").all())
      .toEqual([{ command_kind: "CREATE_OCCURRENCE" }]);
  });
});
