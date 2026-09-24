import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../../src/db";
import { CommerceDomain, DomainError } from "../../src/domain";
import { MockProvider } from "../../src/provider";
import { issueCapability, type CertificationClaim } from "../../src/certification/capability";
import { presentCertificationQuote } from "../../src/certification/checkout-admission";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { CertificationPhase } from "../../src/certification/run";
import { testSecret } from "../support/certification-secret";

/**
 * The quote a certification may take behind its own fence, and nothing wider.
 *
 * `checkoutContext` answers the public sales gate. Letting a certification
 * quote behind the deployment fence must not become a way around that gate for
 * anything else: another occurrence, a run at another step, a promo, or an
 * operator's emergency stop. The real-router E2E proves the path works; this
 * proves how little it opens.
 */

const SHA = "f".repeat(40);
const SESSION = "deploy-session";
const RUN = "certification-deploy-session";
const now = new Date();

const sourceCommit = process.env.SOURCE_COMMIT;
beforeEach(() => { process.env.SOURCE_COMMIT = SHA; });
afterEach(() => { if (sourceCommit === undefined) delete process.env.SOURCE_COMMIT; else process.env.SOURCE_COMMIT = sourceCommit; });

const world = (phase: CertificationPhase = "OCCURRENCE_OPEN") => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city', 'moscow', 'Москва')").run();
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-28.1', datetime('now'), ?, 1)")
    .run(randomUUID(), readFileSync("commerce/legal/production-manifest.json", "utf8"));
  db.prepare("UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1 WHERE singleton = 1").run();
  const occurrence = (id: string) => db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      venue_status, venue_disclosure_text, venue_announce_by, visibility, sales_status)
    VALUES (?, 'city', 'Certification', '2026-12-15T15:00:00.000Z', '2026-12-15T18:00:00.000Z', 'Europe/Moscow', 100, 1,
      'TO_BE_ANNOUNCED', 'Announced later', '2026-12-08T09:00:00.000Z', 'PUBLISHED', 'OPEN')`).run(id);
  occurrence("fixture");
  occurrence("someone-elses-event");
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'RECOVERY_REQUIRED', 'NEW_LINEAGE_ONLY',
      '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
      datetime('now'), datetime('now'), 1)`).run(SESSION, SHA, SHA);
  new SqliteCertificationRunStore(db).create({
    runId: RUN, revision: 1, releaseSha: SHA, phase, direction: "NORMAL", startedAt: now.toISOString(), occurrenceId: "fixture",
  });
  // The runtime's own record of what this run created.
  db.prepare(`INSERT INTO certification_catalogue_mutations(run_id, command_kind, command_id, occurrence_id, occurrence_json)
    VALUES (?, 'CREATE_OCCURRENCE', 'create', 'fixture', '{}')`).run(RUN);
  const { capability, nonce } = issueCapability(new SqliteCertificationCapabilityStore(db),
    { runId: RUN, deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: 3_600_000 }, now, testSecret());
  const claim: CertificationClaim = { capabilityId: capability.id, runId: RUN, nonce };
  const domain = new CommerceDomain(db, new MockProvider());
  // `null` is "no claim at all"; a default parameter would swallow `undefined`.
  const quote = (occurrenceId: string, extra: { promoCode?: string } = {}, presented: CertificationClaim | null = claim) =>
    domain.checkoutContext({ occurrenceId, ...extra, certification: presented ? presentCertificationQuote(db, presented, { occurrenceId, ...extra }) : undefined });
  return { db, capability, claim, quote };
};

const refusal = (run: () => unknown): string => {
  try { run(); return "QUOTED"; } catch (error) { return error instanceof DomainError || error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error); }
};

describe("a certification quote behind its own fence", () => {
  it("is issued for the run's own fixture, and spends nothing", () => {
    const { db, capability, quote } = world();
    expect(quote("fixture")).toMatchObject({ quote_id: expect.any(String) });
    expect(new SqliteCertificationCapabilityStore(db).get(capability.id)?.consumedAt).toBeNull();
  });

  it("leaves the fence shut to everyone without a claim", () => {
    const { quote } = world();
    expect(refusal(() => quote("fixture", {}, null))).toBe("SALES_TEMPORARILY_PAUSED");
  });

  it("does not open for any other occurrence", () => {
    const { quote } = world();
    expect(refusal(() => quote("someone-elses-event"))).toBe("CERTIFICATION_QUOTE_NOT_THIS_RUN");
  });

  it("does not open for a run at any other step", () => {
    for (const phase of ["NEW", "OCCURRENCE_PUBLISHED", "QUOTE_READY", "CHECKOUT_SUBMITTING"] as const) {
      const { quote } = world(phase);
      expect(refusal(() => quote("fixture")), phase).toBe("CERTIFICATION_RUN_NOT_QUOTING");
    }
  });

  it("carries no promo or referral", () => {
    const { quote } = world();
    expect(refusal(() => quote("fixture", { promoCode: "ANY" }))).toBe("CERTIFICATION_QUOTE_ATTRIBUTION_FORBIDDEN");
  });

  it("never passes the operator's emergency stop", () => {
    const { db, quote } = world();
    db.prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1").run();
    expect(refusal(() => quote("fixture"))).toBe("SALES_TEMPORARILY_PAUSED");
  });

  it("refuses a claim whose bearer is wrong", () => {
    const { claim, quote } = world();
    expect(refusal(() => quote("fixture", {}, { ...claim, nonce: `v1.${"0".repeat(64)}` }))).not.toBe("QUOTED");
  });
});
