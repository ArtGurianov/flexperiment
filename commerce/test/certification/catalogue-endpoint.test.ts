import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { issueCapability } from "../../src/certification/capability";
import {
  authenticateCertificationService, CertificationEndpointError,
  parseCatalogueCommandRequest, performCertificationCatalogueCommand, type CatalogueEndpointPorts,
} from "../../src/certification/catalogue-endpoint";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { OccurrenceView } from "../../src/certification/evidence";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const SESSION = "deploy-session";
const now = new Date("2026-09-20T12:00:00.000Z");
const occurrence: OccurrenceView = { id: "occ", title: "Certification", visibility: "HIDDEN", sales_status: "CLOSED" };

const body = (over: Record<string, unknown> = {}) => ({
  run_id: "run",
  command_id: "command-0001",
  reason: "Production E2E certification run",
  claim: { capability_id: "cap", run_id: "run", nonce: "nonce" },
  kind: "CREATE_OCCURRENCE",
  draft: {
    city_id: "city", starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T12:00:00.000Z",
    venue_disclosure_text: "Announced later", venue_announce_by: "2026-09-25T00:00:00.000Z",
  },
  ...over,
});

let db: Database.Database;
/** The capability's own id and nonce, which only the store can mint. */
let claim: { capability_id: string; run_id: string; nonce: string };
let ports: CatalogueEndpointPorts;
let performed: number;

const session = (targetSha = SHA, gateClosed: 0 | 1 = 1, id = SESSION, state = "DEPLOYING") =>
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, ?, ?, 'OLD_LINEAGE_ALLOWED',
      '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
      '2026-09-19T00:00:00.000Z', '2099-01-01T00:00:00.000Z', ?)`).run(id, targetSha, targetSha, state, gateClosed);

const armed = (releaseSha = SHA) => {
  const runs = new SqliteCertificationRunStore(db);
  const command = { kind: "CREATE_OCCURRENCE" as const, idempotencyKey: "command-0001", draft: {
    cityId: "city", startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z",
    venueDisclosureText: "Announced later", venueAnnounceBy: "2026-09-25T00:00:00.000Z",
  } };
  runs.create({ runId: "run", revision: 1, releaseSha, phase: "NEW", direction: "NORMAL", startedAt: now.toISOString(), pendingCommand: command });
  const capability = issueCapability(new SqliteCertificationCapabilityStore(db),
    { runId: "run", deploymentSessionId: SESSION, releaseSha, maxAmountKopecks: 100, ttlMs: 300_000 }, now);
  claim = { capability_id: capability.id, run_id: "run", nonce: capability.nonce };
  return capability;
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city', 'city', 'City')").run();
  performed = 0;
  ports = {
    db,
    now: () => now,
    runtimeReleaseSha: () => SHA,
    createOccurrence: () => { performed += 1; return occurrence; },
    patchOccurrence: () => { performed += 1; return occurrence; },
  };
});

describe("the certification service credential", () => {
  const digest = createHash("sha256").update("s3cret-token").digest("hex");

  it("accepts the configured token and nothing else", () => {
    expect(() => authenticateCertificationService("Bearer s3cret-token", digest)).not.toThrow();
    for (const wrong of ["Bearer wrong", "s3cret-token", "Bearer ", "", undefined]) {
      expect(() => authenticateCertificationService(wrong, digest)).toThrow("CERTIFICATION_SERVICE_UNAUTHENTICATED");
    }
  });

  it("refuses everything when no credential is configured", () => {
    // An unconfigured server must not be an open one.
    expect(() => authenticateCertificationService("Bearer anything", undefined)).toThrow("CERTIFICATION_SERVICE_NOT_CONFIGURED");
    expect(() => authenticateCertificationService("Bearer anything", "  ")).toThrow("CERTIFICATION_SERVICE_NOT_CONFIGURED");
  });

  it("holds a digest, never the token, and compares it in constant time", () => {
    const source = readFileSync("commerce/src/certification/catalogue-endpoint.ts", "utf8");
    expect(source).toContain("timingSafeEqual");
    // A token checked with === leaks its prefix through timing, and this one
    // opens a fence.
    expect(source).not.toMatch(/token\s*===/);
  });
});

describe("what the endpoint will accept as a command", () => {
  it("parses exactly three kinds and refuses anything else", () => {
    expect(parseCatalogueCommandRequest(body()).command.kind).toBe("CREATE_OCCURRENCE");
    expect(parseCatalogueCommandRequest(body({ kind: "PUBLISH_OCCURRENCE", occurrence_id: "occ", expected_revision: 3 })).command)
      .toMatchObject({ kind: "PUBLISH_OCCURRENCE", occurrenceId: "occ", expectedRevision: 3 });
    expect(() => parseCatalogueCommandRequest(body({ kind: "CANCEL_OCCURRENCE" }))).toThrow("CERTIFICATION_CATALOGUE_REQUEST_INVALID");
    expect(() => parseCatalogueCommandRequest(body({ kind: "" }))).toThrow("CERTIFICATION_CATALOGUE_REQUEST_INVALID");
  });

  it("forwards no method, path or free-form payload", () => {
    // A general remote admin executor guarded by a token would be an admin API
    // with one more credential, which is the opposite of a scoped
    // certification. The command's body is built by the server.
    const source = readFileSync("commerce/src/certification/catalogue-endpoint.ts", "utf8");
    for (const forbidden of ["method", "path", "forward", "body.payload"]) {
      expect(source.toLowerCase()).not.toContain(`request.${forbidden}`);
    }
    const parsed = parseCatalogueCommandRequest(body({ payload: { capacity: 5000 }, price_kopecks: 1 }));
    expect(JSON.stringify(parsed)).not.toContain("5000");
  });

  it("refuses a claim naming a different run than the command", () => {
    // Two fields that could disagree would be two ways of saying which
    // certification this is.
    expect(() => parseCatalogueCommandRequest(body({ claim: { capability_id: "cap", run_id: "other", nonce: "nonce" } })))
      .toThrow("CERTIFICATION_CATALOGUE_REQUEST_INVALID");
  });

  it("refuses malformed identifiers and timestamps rather than passing them on", () => {
    for (const over of [{ run_id: "" }, { command_id: "../escape" }, { reason: "" },
      { draft: { ...body().draft, starts_at: "yesterday" } }, { draft: { ...body().draft, city_id: "" } }]) {
      expect(() => parseCatalogueCommandRequest(body(over))).toThrow("CERTIFICATION_CATALOGUE_REQUEST_INVALID");
    }
  });
});

describe("the context a catalogue command must be in", () => {
  it("performs the command when run, fence, runtime and capability all agree", () => {
    session();
    armed();
    expect(performCertificationCatalogueCommand(ports, parseCatalogueCommandRequest(body({ claim })))).toEqual(occurrence);
    expect(performed).toBe(1);
    // Validated, never spent: the capability is spent once, by the checkout.
    expect(new SqliteCertificationCapabilityStore(db).get(claim.capability_id)?.consumedAt).toBeNull();
  });

  it("refuses when no deploy session holds the fence", () => {
    // A certification outside a cutover is not a certification.
    session(SHA, 0);
    armed();
    expect(() => performCertificationCatalogueCommand(ports, parseCatalogueCommandRequest(body({ claim }))))
      .toThrow("CERTIFICATION_NO_ACTIVE_DEPLOY_SESSION");
    expect(performed).toBe(0);
  });

  it("refuses when the runtime answering is not the one being certified", () => {
    // A container still serving the old commit would otherwise publish an
    // occurrence on behalf of a release it is not running.
    session();
    armed();
    expect(() => performCertificationCatalogueCommand({ ...ports, runtimeReleaseSha: () => OTHER }, parseCatalogueCommandRequest(body({ claim }))))
      .toThrow("CERTIFICATION_RUNTIME_RELEASE_MISMATCH");
    expect(() => performCertificationCatalogueCommand({ ...ports, runtimeReleaseSha: () => "" }, parseCatalogueCommandRequest(body({ claim }))))
      .toThrow("CERTIFICATION_RUNTIME_COMMIT_UNKNOWN");
    expect(performed).toBe(0);
  });

  it("refuses a run for a different release than the fence is deploying", () => {
    session();
    armed(OTHER);
    expect(() => performCertificationCatalogueCommand(ports, parseCatalogueCommandRequest(body({ claim }))))
      .toThrow("CERTIFICATION_RUNTIME_RELEASE_MISMATCH");
  });

  it("refuses an expired, retired or foreign capability", () => {
    session();
    armed();
    const late = { ...ports, now: () => new Date(now.getTime() + 10 * 60_000) };
    expect(() => performCertificationCatalogueCommand(late, parseCatalogueCommandRequest(body({ claim }))))
      .toThrow("CERTIFICATION_CAPABILITY_EXPIRED");

    expect(() => performCertificationCatalogueCommand(ports, parseCatalogueCommandRequest(body({ claim: { ...claim, nonce: "wrong" } }))))
      .toThrow("CERTIFICATION_CAPABILITY_NONCE_MISMATCH");
    expect(performed).toBe(0);
  });

  it("refuses a run that does not exist", () => {
    session();
    expect(() => performCertificationCatalogueCommand(ports, parseCatalogueCommandRequest(body())))
      .toThrow(CertificationEndpointError);
  });

  it("returns the same occurrence for a repeated command id without mutating again", () => {
    session();
    armed();
    const request = parseCatalogueCommandRequest(body({ claim }));
    expect(performCertificationCatalogueCommand(ports, request)).toEqual(occurrence);
    expect(performCertificationCatalogueCommand(ports, request)).toEqual(occurrence);
    expect(performed).toBe(1);
  });
});
