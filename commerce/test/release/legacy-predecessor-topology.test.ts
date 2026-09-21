import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { LegacyPredecessorTopologyReader } from "../../src/release/legacy-predecessor-topology";
import { migrate } from "../../src/db";

/**
 * The predecessor bridge, against a database shaped exactly like the one a
 * cutover starts from.
 *
 * The real copy carries personal data and is never committed, so the fixture
 * below is built from what that copy actually contains: the 61-migration ledger
 * of `726dc412`, `runtime_release_evidence` with one row per unit, no
 * `schema_identity` and no `runtime_instance_evidence`. The names come from the
 * deployed tree rather than being invented.
 *
 * Two facts from the real copy drive the design and are asserted here:
 * commerce's row is written once at startup and never refreshed, while the
 * worker's is a heartbeat. Ageing them the same way would refuse a healthy
 * predecessor for having been up a while.
 */

const PREDECESSOR = "726dc412f62a726cc1f93a03b91de0834c4333e1";
const OTHER = "b".repeat(40);
const NOW = new Date("2026-09-21T03:10:00.000Z");
/**
 * The predecessor's ledger, written down rather than looked up.
 *
 * An earlier version read these from `git ls-tree 726dc412`, which passed
 * locally only because that object happened to be fetched, and failed in CI
 * where the checkout has no such commit. A test that depends on the state of a
 * git directory is not testing the code. These names are the predecessor's
 * identity, so the test states them.
 */
const LEDGER = [
  "0001_initial.sql",
  "0002_operations.sql",
  "0003_provider_phase0.sql",
  "0004_legal_evidence.sql",
  "0005_provider_webhook_evidence.sql",
  "0006_legal_release_publish_events.sql",
  "0007_reservation_recovery.sql",
  "0008_venue_announcement_deadline.sql",
  "0009_admin_sessions.sql",
  "0010_occurrence_visibility_sales_invariant.sql",
  "0011_occurrence_cancellation_and_refund_capabilities.sql",
  "0012_refund_hardening.sql",
  "0013_promoter_attribution_rewards.sql",
  "0014_prepared_settlement_hardening.sql",
  "0015_city_interest_requests.sql",
  "0016_city_interest_lifecycle.sql",
  "0017_city_interest_delivery_lifecycle.sql",
  "0018_city_interest_suppression.sql",
  "0019_city_interest_notification_epochs.sql",
  "0020_email_outbox_recovery_hardening.sql",
  "0021_city_interest_request_epochs.sql",
  "0022_create_unknown_recovery.sql",
  "0023_email_operational_attention.sql",
  "0024_tochka_webhook_collision_evidence.sql",
  "0025_tochka_webhook_conflicts_fail_closed.sql",
  "0026_post_purchase_occurrence_lifecycle.sql",
  "0027_occurrence_notification_payload_attention.sql",
  "0028_customer_participant_ticketing.sql",
  "0029_unisender_event_dump_reconciliation.sql",
  "0030_unisender_event_dump_probe_and_saturation.sql",
  "0031_participant_age_band.sql",
  "0032_release_sales_gate.sql",
  "0033_runtime_release_evidence.sql",
  "0034_worker_sweep_evidence.sql",
  "0035_promo_codes_v0.sql",
  "0036_tochka_provider_error_evidence.sql",
  "0037_emergency_sales_gate.sql",
  "0038_occurrence_availability_notifications.sql",
  "0039_email_delivery_outcome.sql",
  "0040_outbox_authority_control.sql",
  "0041_outbox_attempt.sql",
  "0042_agent_referrals_agents_rebuild.sql",
  "0043_agent_referrals_foundation.sql",
  "0044_partner_identity.sql",
  "0045_engagement_publication.sql",
  "0046_attribution_reward.sql",
  "0047_act_payment_settlement.sql",
  "0048_ord_reporting.sql",
  "0049_agent_referrals_integration_hardening.sql",
  "0050_agent_referrals_legal_profile_provenance_rebuild.sql",
  "0051_agent_referrals_legal_profile_supersession.sql",
  "0052_agent_referrals_unified_legal_requisites.sql",
  "0053_agent_referrals_tax_treatment_ord_canonicalization.sql",
  "0054_partner_command_idempotency.sql",
  "0055_partner_legal_profile_draft_revision.sql",
  "0056_legal_profile_change_request_sequence.sql",
  "0057_partner_invite_capability_head.sql",
  "0058_agents_legal_identity_cleanup.sql",
  "0059_agents_contract_reference_removal.sql",
  "0060_agent_referrals_framework_reissuance.sql",
  "0061_occurrence_admin_reserved_seats.sql",
];

let db: Database.Database;

const legacyDatabase = () => {
  const fixture = new Database(":memory:");
  fixture.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE runtime_release_evidence (
      unit TEXT PRIMARY KEY, source_commit TEXT NOT NULL, started_at TEXT NOT NULL,
      observed_at TEXT NOT NULL, last_successful_sweep_at TEXT);`);
  const record = fixture.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
  for (const version of LEDGER) record.run(version);
  const evidence = fixture.prepare(`INSERT INTO runtime_release_evidence(unit, source_commit, started_at, observed_at, last_successful_sweep_at)
    VALUES (?, ?, ?, ?, ?)`);
  // Exactly the shape the real copy holds.
  evidence.run("COMMERCE", PREDECESSOR, "2026-09-20T21:00:06Z", "2026-09-20T21:00:06Z", null);
  evidence.run("WORKER", PREDECESSOR, "2026-09-20T21:00:06Z", "2026-09-21T03:07:23Z", "2026-09-21T03:07:23Z");
  return fixture;
};

const answering = (sha = PREDECESSOR, ready = 200) => (async (url: string) =>
  String(url).includes("readyz")
    ? new Response("{}", { status: ready })
    : new Response(JSON.stringify({ source_commit: sha }), { status: 200 })) as unknown as typeof fetch;

const reader = (over: Partial<ConstructorParameters<typeof LegacyPredecessorTopologyReader>[0]> = {}) =>
  new LegacyPredecessorTopologyReader({
    frontendReleaseUrl: "https://flexperiment.invalid/release.json",
    adminReleaseUrl: "https://admin.flexperiment.invalid/release.json",
    commerceReadyUrl: "https://commerce.flexperiment.invalid/readyz",
    db, deployRef: { read: async () => PREDECESSOR },
    expectedPredecessorSha: PREDECESSOR, expectedLedgerLength: 61,
    fetch: answering(), now: () => NOW, ...over,
  });

beforeEach(() => { db = legacyDatabase(); });

describe("reading the predecessor a cutover starts from", () => {
  it("answers with four surfaces and the pointer", async () => {
    expect(await reader().observe()).toEqual({
      runtime: { frontend: PREDECESSOR, admin: PREDECESSOR, commerce: PREDECESSOR, worker: PREDECESSOR },
      controlPlane: { productionDeployRefSha: PREDECESSOR },
    });
  });

  it("is the only thing that can: the canonical reader cannot read this database at all", async () => {
    // This is why the bridge exists. `runtime_instance_evidence` arrives with
    // the launch baseline, so on the database a cutover starts from the
    // canonical reader throws - before the fence, on the first line.
    const { ProductionTopologyReader } = await import("../../src/release/topology-reader");
    const canonical = new ProductionTopologyReader({
      frontendReleaseUrl: "https://flexperiment.invalid/release.json",
      adminReleaseUrl: "https://admin.flexperiment.invalid/release.json",
      db, deployRef: { read: async () => PREDECESSOR }, fetch: answering(), now: () => NOW,
    });
    await expect(canonical.observe()).rejects.toThrow("no such table: runtime_instance_evidence");
  });

  it("refuses a unit that never recorded anything", async () => {
    db.prepare("DELETE FROM runtime_release_evidence WHERE unit = 'COMMERCE'").run();
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_UNIT_MISSING: COMMERCE");
  });

  it("refuses a worker whose heartbeat has stopped", async () => {
    // Here staleness is real evidence of a stopped worker: this row is a
    // heartbeat, refreshed as it sweeps.
    await expect(reader({ now: () => new Date("2026-09-21T05:00:00.000Z") }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_WORKER_STALE");
  });

  it("refuses a worker that has never completed a sweep", async () => {
    db.prepare("UPDATE runtime_release_evidence SET last_successful_sweep_at = NULL WHERE unit = 'WORKER'").run();
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_WORKER_NEVER_SWEPT");
  });

  it("does not age commerce's row, because it is a start record and not a heartbeat", async () => {
    // The real copy's commerce row was six hours old and the predecessor was
    // perfectly healthy. Ageing it would refuse a cutover for the crime of
    // having been up for a while.
    db.prepare("UPDATE runtime_release_evidence SET observed_at = '2026-09-01T00:00:00Z' WHERE unit = 'COMMERCE'").run();
    await expect(reader().observe()).resolves.toMatchObject({ runtime: { commerce: PREDECESSOR } });
  });

  it("proves commerce is up separately, without a credential", async () => {
    // Its row says which commit started, not that anything is still running.
    // The old runtime has no unauthenticated surface naming its commit, and its
    // admin evidence route sits behind a browser session this must not drive.
    await expect(reader({ fetch: answering(PREDECESSOR, 503) }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_COMMERCE_NOT_READY");
  });

  it("refuses when any surface or the pointer disagrees", async () => {
    db.prepare("UPDATE runtime_release_evidence SET source_commit = ? WHERE unit = 'WORKER'").run(OTHER);
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_TOPOLOGY_DISAGREES: worker");

    db = legacyDatabase();
    await expect(reader({ deployRef: { read: async () => OTHER } }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_TOPOLOGY_DISAGREES: deploy ref");

    db = legacyDatabase();
    await expect(reader({ fetch: answering(OTHER) }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_TOPOLOGY_DISAGREES");
  });

  it("refuses a legacy database that is not this predecessor", async () => {
    // Bound to one reviewed commit: another legacy database is an operator
    // pointing a cutover at something nobody looked at.
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LEDGER.at(-1));
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_LEDGER_UNEXPECTED: 60 migrations");
  });

  it("refuses a database that has already been launched", async () => {
    // Asking this reader after the cutover would hand back a frozen topology
    // for a lineage it knows nothing about.
    const launched = new Database(":memory:");
    launched.pragma("foreign_keys = ON");
    migrate(launched);
    db = launched;
    await expect(reader().observe()).rejects.toThrow(/LEGACY_PREDECESSOR_LINEAGE_NOT_LEGACY|LEGACY_PREDECESSOR_ALREADY_LAUNCHED/);
  });

  it("refuses a database carrying the launch evidence table", async () => {
    db.exec("CREATE TABLE runtime_instance_evidence (instance_id TEXT PRIMARY KEY)");
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_HAS_LAUNCH_EVIDENCE");
  });

  it("refuses a legacy database with no evidence at all", async () => {
    db.exec("DROP TABLE runtime_release_evidence");
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_HAS_NO_EVIDENCE");
  });

  it("writes nothing", async () => {
    // Read-only by construction: it never migrates and never records.
    const before = db.prepare("SELECT COUNT(*) AS n FROM runtime_release_evidence").get();
    await reader().observe();
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_release_evidence").get()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_identity'").get()).toBeUndefined();
  });

  it("restores the same frozen topology after a predecessor restart", async () => {
    // What a bootstrap rollback needs: the worker comes back, refreshes its
    // row, and the observation matches the snapshot the cutover froze.
    const frozen = await reader().observe();
    db.prepare("UPDATE runtime_release_evidence SET observed_at = ?, last_successful_sweep_at = ? WHERE unit = 'WORKER'")
      .run("2026-09-21T03:09:30Z", "2026-09-21T03:09:30Z");
    expect(await reader().observe()).toEqual(frozen);
  });
});
