import { randomUUID, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { MockProvider } from "../src/provider";
import { agentPatchSchema, agentSchema } from "../src/types";

/**
 * 0042 makes the DATABASE capable of storing contractor_type = 'ORGANIZATION'.
 * It must not change what the LEGACY agent surface can create or patch:
 * agentSchema/agentPatchSchema stay two-valued (A4-10), and the only place
 * that enforces this today is the Zod parse in admin.post("/agents") /
 * admin.patch("/agents/:id") (api.ts) - domain.createAgent()/patchAgent()
 * themselves take unchecked Record<string, unknown> and trust the caller to
 * have already validated. ORGANIZATION is created only by a future
 * Agent Referrals gated path this PR does not build.
 */

process.env.COMMERCE_SESSION_SECRET = "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT = `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
const { createApp } = await import("../src/api");

const legacyAgentPayload = (overrides: Record<string, unknown> = {}) => ({
  slug: `legacy-agent-${randomUUID().slice(0, 8)}`,
  display_name: "Legacy Agent",
  legal_name: "Legacy Agent Legal",
  email: `legacy-${randomUUID().slice(0, 8)}@example.test`,
  contractor_type: "SELF_EMPLOYED",
  inn: "123456789012",
  contract_reference: "C-LEGACY",
  default_reward_type: "PERCENT",
  default_reward_value: 1000,
  ...overrides,
});

describe("agentSchema / agentPatchSchema stay two-valued after 0042", () => {
  it("still accepts both legacy contractor_type values", () => {
    expect(agentSchema.safeParse(legacyAgentPayload({ contractor_type: "SELF_EMPLOYED" })).success).toBe(true);
    expect(agentSchema.safeParse(legacyAgentPayload({ contractor_type: "INDIVIDUAL_ENTREPRENEUR" })).success).toBe(true);
  });

  it("rejects ORGANIZATION on create, even though the database can now store it", () => {
    expect(agentSchema.safeParse(legacyAgentPayload({ contractor_type: "ORGANIZATION" })).success).toBe(false);
  });

  it("rejects ORGANIZATION on patch, even though the database can now store it", () => {
    expect(agentPatchSchema.safeParse({ contractor_type: "ORGANIZATION" }).success).toBe(false);
    expect(agentPatchSchema.safeParse({ contractor_type: "SELF_EMPLOYED" }).success).toBe(true);
    expect(agentPatchSchema.safeParse({ contractor_type: "INDIVIDUAL_ENTREPRENEUR" }).success).toBe(true);
  });
});

describe("legacy agent HTTP surface refuses ORGANIZATION end to end, against a DB migrated through 0042", () => {
  const fixture = () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const app = createApp(db, new MockProvider(), undefined, { verify: async () => "PASS" });
    return { db, app };
  };

  const login = async (app: ReturnType<typeof createApp>) => {
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    return { Origin: "https://admin.flexperiment.ru", Cookie: response.headers.get("set-cookie")!, "Content-Type": "application/json" };
  };

  it("POST /v1/admin/agents rejects contractor_type=ORGANIZATION with 422 and creates no row", async () => {
    const { db, app } = fixture();
    const headers = await login(app);
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/agents", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: JSON.stringify(legacyAgentPayload({ contractor_type: "ORGANIZATION" })),
    });
    expect(response.status).toBe(422);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE contractor_type = 'ORGANIZATION'").get()).toEqual({ n: 0 });
  });

  it("POST /v1/admin/agents still accepts SELF_EMPLOYED and INDIVIDUAL_ENTREPRENEUR", async () => {
    const { db, app } = fixture();
    const headers = await login(app);
    const selfEmployed = await app.request("http://admin.flexperiment.ru/v1/admin/agents", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: JSON.stringify(legacyAgentPayload({ contractor_type: "SELF_EMPLOYED" })),
    });
    expect(selfEmployed.status).toBe(201);
    const individualEntrepreneur = await app.request("http://admin.flexperiment.ru/v1/admin/agents", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: JSON.stringify(legacyAgentPayload({ contractor_type: "INDIVIDUAL_ENTREPRENEUR" })),
    });
    expect(individualEntrepreneur.status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual({ n: 2 });
  });

  it("PATCH /v1/admin/agents/:id rejects contractor_type=ORGANIZATION with 422 and leaves the row unchanged", async () => {
    const { db, app } = fixture();
    const headers = await login(app);
    const created = await app.request("http://admin.flexperiment.ru/v1/admin/agents", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: JSON.stringify(legacyAgentPayload({ contractor_type: "SELF_EMPLOYED" })),
    });
    const agent = await created.json() as { id: string };
    const before = db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(agent.id);

    const patched = await app.request(`http://admin.flexperiment.ru/v1/admin/agents/${agent.id}`, {
      method: "PATCH",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ contractor_type: "ORGANIZATION" }),
    });
    expect(patched.status).toBe(422);
    expect(db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(agent.id)).toEqual(before);
    expect(before).toEqual({ contractor_type: "SELF_EMPLOYED" });
  });
});
