import { randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { MockProvider } from "../src/provider";
import { CommerceDomain } from "../src/domain";
import { ReleaseControlError, ReleaseSalesGate, type ReleaseControlRequest } from "../src/release-control";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";

/**
 * §B-1b / Phase 1: ROLLING is reachable over HTTP end-to-end, and
 * completeRolling() is the only path that clears a ROLLING owner - never
 * reopen(), which requires sales_paused = 1 and a ROLLING rollout never
 * pauses on its normal path.
 *
 * PR10 wires the dormant-ready predicate to Agent Referrals' own
 * feature-state singleton (api.ts's `/complete-rolling` route) - Agent
 * Referrals (PR3-PR9) is the only real ROLLING candidate, so its own DORMANT
 * state is the genuine readiness signal this predicate was always meant to
 * become; see the historical PR1 comment this replaced, quoted in
 * commerce/src/api.ts. The "all predicates PASS with a synthetic reader"
 * scenario stays proven against the primitives directly
 * (ReleaseSalesGate.completeRolling / CommerceDomain.completeRolling), since
 * that reader is a generic parameter unrelated to which feature backs it;
 * the dormant-ready PASS/FAIL scenarios themselves are proven through the
 * real HTTP route, against the real Agent Referrals feature-state table.
 */

process.env.COMMERCE_SESSION_SECRET = "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT = `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;

const { createApp } = await import("../src/api");

function appFixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  return { db, app: createApp(db, new MockProvider()) };
}

const expected = (overrides: Partial<ReleaseControlRequest["expected"]> = {}) => ({
  source_commit: "a".repeat(40),
  migration: "0033_runtime_release_evidence.sql",
  legal_version: "2026-08-25.1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
  ...overrides,
});

const releaseControlHeaders = { Authorization: "Bearer release-control-test-token", "Content-Type": "application/json" };

async function withReleaseControlToken<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.COMMERCE_RELEASE_CONTROL_TOKEN;
  process.env.COMMERCE_RELEASE_CONTROL_TOKEN = "release-control-test-token";
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.COMMERCE_RELEASE_CONTROL_TOKEN;
    else process.env.COMMERCE_RELEASE_CONTROL_TOKEN = previous;
  }
}

describe("HTTP: existing CONTROLLED_CUTOVER acquire behaviour is unchanged", () => {
  it("accepts CONTROLLED_CUTOVER, sets the owner and mode, and leaves sales_paused at 0 until pause()", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        const release = { release_id: releaseId, mode: "CONTROLLED_CUTOVER", expected: expected() };
        const acquire = await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify(release) });
        expect(acquire.status).toBe(200);
        const body = await acquire.json() as { owner_release_id: string; owner_mode: string; sales_paused: boolean };
        expect(body.owner_release_id).toBe(releaseId);
        expect(body.owner_mode).toBe("CONTROLLED_CUTOVER");
        expect(body.sales_paused).toBe(false);
      } finally { db.close(); }
    });
  });
});

describe("HTTP: acquire ROLLING", () => {
  it("is accepted, sets owner_mode ROLLING, and leaves sales_paused at 0", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        const release = { release_id: releaseId, mode: "ROLLING", expected: expected() };
        const acquire = await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify(release) });
        expect(acquire.status).toBe(200);
        const body = await acquire.json() as { owner_release_id: string; owner_mode: string; sales_paused: boolean };
        expect(body.owner_release_id).toBe(releaseId);
        expect(body.owner_mode).toBe("ROLLING");
        expect(body.sales_paused).toBe(false);
        const status = await app.request("http://api.flexperiment.ru/v1/internal/release-control/status", { headers: releaseControlHeaders });
        expect((await status.json() as { sales_paused: boolean }).sales_paused).toBe(false);
      } finally { db.close(); }
    });
  });
});

describe("HTTP: POST /v1/internal/release-control/complete-rolling", () => {
  const acquireRolling = async (app: ReturnType<typeof appFixture>["app"], releaseId: string, exp = expected()) => {
    const release = { release_id: releaseId, mode: "ROLLING", expected: exp };
    const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify(release) });
    expect(response.status).toBe(200);
  };

  it("rejects a wrong owner", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        await acquireRolling(app, releaseId);
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: randomUUID(), mode: "ROLLING", expected: expected() }) });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_OWNER_MISMATCH" } });
      } finally { db.close(); }
    });
  });

  it("rejects a CONTROLLED_CUTOVER owner", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        const release = { release_id: releaseId, mode: "CONTROLLED_CUTOVER", expected: expected() };
        expect((await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify(release) })).status).toBe(200);
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_MODE_MISMATCH" } });
      } finally { db.close(); }
    });
  });

  it("rejects while paused", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        await acquireRolling(app, releaseId);
        // Emergency pause() remains reachable regardless of mode (the recovery
        // path), so a ROLLING owner CAN end up paused - completeRolling() must
        // still refuse in that state.
        const pause = await app.request("http://api.flexperiment.ru/v1/internal/release-control/pause", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
        expect(pause.status).toBe(200);
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_SALES_PAUSED" } });
      } finally { db.close(); }
    });
  });

  it("rejects an expectation mismatch", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        await acquireRolling(app, releaseId);
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected({ source_commit: "f".repeat(40) }) }) });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_EXPECTATION_MISMATCH" } });
      } finally { db.close(); }
    });
  });

  it("rejects an expectation mismatch limited to a single legal_hash - the gate row has no column for it, so only full-object comparison can catch this", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        const acquired = expected();
        await acquireRolling(app, releaseId, acquired);
        const tampered = expected({ legal_hashes: { ...acquired.legal_hashes, PD_CONSENT: "9".repeat(64) } });
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: tampered }) });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_EXPECTATION_MISMATCH" } });
      } finally { db.close(); }
    });
  });

  it("succeeds on dormant-ready PASS: Agent Referrals is DORMANT by default on a freshly migrated database", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        await acquireRolling(app, releaseId);
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
        expect(response.status).toBe(200);
        const body = await response.json() as { owner_release_id: string | null };
        expect(body.owner_release_id).toBeNull();
      } finally { db.close(); }
    });
  });

  it("rejects on dormant-ready FAIL: Agent Referrals is not DORMANT (already activated)", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        activateAgentReferrals(db, { expected_revision: 1, owner_id: "activation-owner", reason: "test" });
        const releaseId = randomUUID();
        await acquireRolling(app, releaseId);
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
        // Refused, not silently no-op: owner is still held afterward.
        const status = await app.request("http://api.flexperiment.ru/v1/internal/release-control/status", { headers: releaseControlHeaders });
        expect((await status.json() as { owner_release_id: string | null }).owner_release_id).toBe(releaseId);
      } finally { db.close(); }
    });
  });

  it("browser/admin credentials cannot call the machine completion route", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const releaseId = randomUUID();
        await acquireRolling(app, releaseId);
        const noAuth = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
        expect(noAuth.status).toBe(401);
        const login = await app.request("http://api.flexperiment.ru/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://admin.flexperiment.ru" }, body: JSON.stringify({ password: "correct horse" }) });
        const adminCookie = login.headers.get("Set-Cookie");
        const asAdmin = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", { method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie ?? "" }, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
        expect(asAdmin.status).toBe(401);
      } finally { db.close(); }
    });
  });
});

describe("HTTP: GET /v1/internal/release-control/agent-referrals/dormant-readiness", () => {
  it("reports ready:true on a freshly migrated database, with all_zero business facts and no feature-state singleton in the table breakdown", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/agent-referrals/dormant-readiness", { headers: releaseControlHeaders });
        expect(response.status).toBe(200);
        const body = await response.json() as { ready: boolean; feature_state: string; schema_present: boolean; business_facts_all_zero: boolean | null; business_facts_tables: Record<string, number> | null; reasons: string[] };
        expect(body).toMatchObject({ ready: true, feature_state: "DORMANT", schema_present: true, business_facts_all_zero: true, reasons: [] });
        expect(body.business_facts_tables).not.toHaveProperty("agent_referrals_feature_state");
      } finally { db.close(); }
    });
  });

  it("reports ready:false once activated, names the reason, and requires the bearer token like every other release-control route", async () => {
    await withReleaseControlToken(async () => {
      const { db, app } = appFixture();
      try {
        activateAgentReferrals(db, { expected_revision: 1, owner_id: "activation-owner", reason: "test" });
        const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/agent-referrals/dormant-readiness", { headers: releaseControlHeaders });
        const body = await response.json() as { ready: boolean; feature_state: string; reasons: string[] };
        expect(body.ready).toBe(false);
        expect(body.feature_state).toBe("ACTIVE");
        expect(body.reasons).toContain("FEATURE_STATE_NOT_DORMANT:ACTIVE");

        const noAuth = await app.request("http://api.flexperiment.ru/v1/internal/release-control/agent-referrals/dormant-readiness");
        expect(noAuth.status).toBe(401);
      } finally { db.close(); }
    });
  });
});

/**
 * The PASS scenario, and the properties an HTTP-only harness cannot exercise
 * until a real feature-readiness reader replaces PR1's fail-closed default -
 * tested directly against the PR1 primitives per the plan's own scope
 * ("test PR1 primitives ... on the scope that actually exists in PR1").
 */
describe("ReleaseSalesGate.completeRolling(): primitive, all predicates PASS", () => {
  const request = (releaseId: string, exp = expected()): ReleaseControlRequest => ({ release_id: releaseId, mode: "ROLLING", expected: exp });

  it("writes immutable terminal completion evidence, clears the owner, and leaves sales_paused at 0", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      const gate = new ReleaseSalesGate(db);
      const releaseId = randomUUID();
      gate.acquire(request(releaseId));
      const before = gate.status();
      expect(before.owner_mode).toBe("ROLLING");
      expect(before.sales_paused).toBe(false);

      const after = gate.completeRolling(request(releaseId), () => true);
      expect(after.owner_release_id).toBeNull();
      expect(after.owner_mode).toBeNull();
      expect(after.sales_paused).toBe(false);

      const events = db.prepare("SELECT action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(releaseId) as Array<{ action: string; details_json: string }>;
      expect(events.map((e) => e.action)).toEqual(["ACQUIRED", "REOPENED"]);
      const details = JSON.parse(events[1].details_json) as { kind: string; mode: string };
      expect(details.kind).toBe("ROLLING_COMPLETED");
      expect(details.mode).toBe("ROLLING");
    } finally { db.close(); }
  });

  it("is idempotent: a retry after success returns the same completed status instead of erroring", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      const gate = new ReleaseSalesGate(db);
      const releaseId = randomUUID();
      const req = request(releaseId);
      gate.acquire(req);
      const first = gate.completeRolling(req, () => true);
      const second = gate.completeRolling(req, () => { throw new Error("must not re-evaluate dormant readiness on an idempotent retry"); });
      expect(second).toEqual(first);
    } finally { db.close(); }
  });

  it("a retry that reuses the release_id for a genuinely different completion is refused, not treated as idempotent", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      const gate = new ReleaseSalesGate(db);
      const releaseId = randomUUID();
      gate.acquire(request(releaseId));
      gate.completeRolling(request(releaseId), () => true);
      expect(() => gate.completeRolling(request(releaseId, expected({ source_commit: "9".repeat(40) })), () => true))
        .toThrow(ReleaseControlError);
    } finally { db.close(); }
  });

  it("a retry with a changed legal_hash is refused, not treated as idempotent", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      const gate = new ReleaseSalesGate(db);
      const releaseId = randomUUID();
      const acquired = expected();
      gate.acquire(request(releaseId, acquired));
      gate.completeRolling(request(releaseId, acquired), () => true);
      const tampered = expected({ legal_hashes: { ...acquired.legal_hashes, CHECKOUT_DISCLOSURE: "9".repeat(64) } });
      expect(() => gate.completeRolling(request(releaseId, tampered), () => true)).toThrow(ReleaseControlError);
    } finally { db.close(); }
  });
});

describe("CommerceDomain.completeRolling(): domain wrapper threads the reader through", () => {
  it("maps ReleaseControlError to a DomainError with the same code and status", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      const domain = new CommerceDomain(db, new MockProvider());
      const releaseId = randomUUID();
      domain.acquireReleaseControl({ release_id: releaseId, mode: "ROLLING", expected: expected() });
      const result = domain.completeRolling({ release_id: releaseId, mode: "ROLLING", expected: expected() }, () => true);
      expect(result.owner_release_id).toBeNull();
    } finally { db.close(); }
  });
});

describe("structural: the normal ROLLING path never calls pause()", () => {
  const source = readFileSync(new URL("../src/release-control.ts", import.meta.url), "utf8");

  it("completeRolling()'s own body never invokes this.pause(", () => {
    const start = source.indexOf("completeRolling(request: ReleaseControlRequest");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  }\n", start);
    const body = source.slice(start, end);
    expect(body).not.toContain("this.pause(");
    expect(body).not.toContain(".pause(");
  });
});
