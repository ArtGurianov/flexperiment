# v1 production evidence audit (ART-155)

Historical source: https://linear.app/art-gurianov/issue/ART-155

This is the original F1.4 read-only aggregate-only script, archived so F9.1 can re-run the exact query set before cutover. Execute only inside the v1 commerce container with its production read-only database path. Never record individual identifiers, email, hostnames, database paths, or secrets in output. Review the current execution environment and legal data-handling requirements before running. The admission decision requires the freeze to be active and external tails closed; never rely on the 2026-09-28 pass as proof of a later state.

```sh
cd /app && node --input-type=module <<'EOF'
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const AUDIT_VERSION = "F1.4-v1";
const path = process.env.COMMERCE_DATABASE_PATH;
if (!path) throw new Error("COMMERCE_DATABASE_PATH is not set");
const db = new Database(path, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");

// The commit this container was deployed from: the same trusted deployment
// metadata v1 itself reports. Anything but 40 lower-case hex is not evidence.
const envCommit = process.env.SOURCE_COMMIT?.trim() ?? "";
const sourceCommit = /^[0-9a-f]{40}$/.test(envCommit) ? envCommit : null;

const byCert = "o.certification_run_id IS NOT NULL AS certification";
const queries = {
  sales_gate: "SELECT sales_paused, paused_at, reopened_at FROM emergency_sales_gate",
  referrals_feature_state: "SELECT state, updated_at FROM agent_referrals_feature_state",
  legal_publications: "SELECT action, COUNT(*) AS n FROM legal_release_publish_events GROUP BY 1",

  orders: "SELECT certification_run_id IS NOT NULL AS certification, COUNT(*) AS n, COUNT(pd_consent_accepted_at) AS pd_consents, COUNT(public_offer_accepted_at) AS offer_acceptances, COUNT(DISTINCT customer_email_hash) AS distinct_buyers FROM orders GROUP BY 1",
  payments: `SELECT ${byCert}, p.state, p.status, COUNT(*) AS n, SUM(p.captured_amount_kopecks) AS captured_kopecks FROM payments p JOIN orders o ON o.id = p.order_id GROUP BY 1, 2, 3`,
  refunds: `SELECT ${byCert}, r.status, COUNT(*) AS n, SUM(r.amount_kopecks) AS kopecks FROM refunds r JOIN orders o ON o.id = r.order_id GROUP BY 1, 2`,
  refund_obligations: `SELECT ${byCert}, ro.status, COUNT(*) AS n, SUM(ro.target_refunded_amount_kopecks) AS kopecks FROM refund_obligations ro JOIN payments p ON p.id = ro.payment_id JOIN orders o ON o.id = p.order_id GROUP BY 1, 2`,
  bookings: `SELECT ${byCert}, b.status, COUNT(*) AS n FROM bookings b JOIN orders o ON o.id = b.order_id GROUP BY 1, 2`,
  tickets: "SELECT status, COUNT(*) AS n FROM tickets GROUP BY 1",
  certification_runs: "SELECT phase, direction, COUNT(*) AS n, COUNT(completed_at) AS completed FROM certification_runs GROUP BY 1, 2",
  provider_webhooks: "SELECT provider, status, COUNT(*) AS n FROM provider_webhook_events GROUP BY 1, 2",

  city_interest_requests: "SELECT COUNT(*) AS n, COUNT(DISTINCT email_hash) AS distinct_emails, COUNT(*) - COUNT(superseded_at) AS current FROM city_interest_requests",
  occurrence_notification_requests: "SELECT COUNT(*) AS n, COUNT(DISTINCT email_hash) AS distinct_emails, COUNT(*) - COUNT(superseded_at) AS current FROM occurrence_notification_requests",
  email_outbox: "SELECT type, status, COUNT(*) AS n, COUNT(delivered_at) AS delivered, COUNT(DISTINCT recipient_email_hash) AS distinct_recipients FROM email_outbox GROUP BY 1, 2",
  unisender_dumps: "SELECT state, COUNT(*) AS n FROM unisender_event_dump_runs GROUP BY 1",

  partner_identities: "SELECT onboarding_state, COUNT(*) AS n, COUNT(destroyed_at) AS destroyed, COUNT(submitted_inn) AS with_inn FROM partner_identities GROUP BY 1",
  partners_legacy: "SELECT COUNT(*) AS n, SUM(enabled) AS enabled FROM partners",
  partner_invites: "SELECT purpose, COUNT(*) AS n, COUNT(consumed_at) AS consumed FROM partner_invite_capabilities GROUP BY 1",
  acceptances: "SELECT (SELECT COUNT(*) FROM framework_acceptances) AS framework, (SELECT COUNT(*) FROM engagement_acceptances) AS engagement, (SELECT COUNT(*) FROM settlement_act_acceptances) AS settlement_act, (SELECT COUNT(*) FROM ord_reporting_delegations) AS ord_delegations",
  engagements: "SELECT lifecycle_state, COUNT(*) AS n FROM engagements GROUP BY 1",
  promo_codes: "SELECT status, COUNT(*) AS n FROM promo_codes GROUP BY 1",
  referral_rewards: "SELECT COUNT(*) AS n, SUM(amount_kopecks) AS kopecks FROM referral_rewards",

  reward_settlements: "SELECT status, method, COUNT(*) AS n, SUM(amount_kopecks) AS kopecks FROM reward_settlements GROUP BY 1, 2",
  settlement_acts: "SELECT COUNT(*) AS n, COUNT(presented_at) AS presented FROM settlement_acts",
  payout_authorizations: "SELECT COUNT(*) AS n FROM payment_authorizations",
  payouts: "SELECT status, COUNT(*) AS n, COUNT(made_at) AS made, SUM(amount_kopecks) AS kopecks FROM payment_attempts GROUP BY 1",
  npd_receipts: "SELECT COUNT(*) AS n FROM npd_receipts",

  ord_creatives: "SELECT local_state, vk_submission_state, COUNT(*) AS n, COUNT(erid) AS with_erid FROM ord_creative_registrations GROUP BY 1, 2",
  ord_operations: "SELECT operation_kind, local_state, vk_submission_state, COUNT(*) AS n, COUNT(vk_external_id) AS at_vk FROM ord_provider_operations GROUP BY 1, 2, 3",
  ord_period_reports: "SELECT submission_state, COUNT(*) AS n FROM ord_distribution_period_reports GROUP BY 1",
  ord_paid_invoices: "SELECT submission_state, COUNT(*) AS n FROM ord_paid_invoice_payloads GROUP BY 1",
};

const header = {
  schema_identity: "SELECT lineage, baseline_version, established_at FROM schema_identity",
  schema_migrations: "SELECT COUNT(*) AS n, MAX(version) AS latest FROM schema_migrations",
  runtime_instances: "SELECT unit, source_commit, MAX(heartbeat_at) AS last_heartbeat_at FROM runtime_instance_evidence GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10",
};
const queriesSha256 = createHash("sha256").update(JSON.stringify({ header, queries })).digest("hex");

const report = db.transaction(() => {
  const identity = db.prepare(header.schema_identity).get() ?? {};
  return {
    auditVersion: AUDIT_VERSION,
    queriesSha256,
    observedAt: new Date().toISOString(),
    sourceCommit,
    sourceCommitEvidence: sourceCommit ? "CONTAINER_ENV" : "UNAVAILABLE",
    schemaLineage: identity.lineage ?? null,
    baselineVersion: identity.baseline_version ?? null,
    schemaEstablishedAt: identity.established_at ?? null,
    migrations: db.prepare(header.schema_migrations).get(),
    runtimeInstances: db.prepare(header.runtime_instances).all(),
    counts: Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, db.prepare(sql).all()])),
  };
})();
console.log(JSON.stringify(report, null, 1));
EOF
```

## Historical results

- Query set SHA-256: `74b64fcbc2532a3341c5add64ed88ad83fca58d0e13617d4e713244b0d0891cd`.
- 2026-09-28T04:31:56Z run 1: evidence CLEAN but admission PENDING, sales not paused and referrals ACTIVE.
- 2026-09-28T04:53:21.573Z run 2: HARD_CUT_ADMITTED; sales paused and referrals SUSPENDED; no change to aggregate counts.
- Source commit: `3ad07cfcb53e861fc481c44d806b91743eb239c6`; lineage `flexperiment-launch`, seven migrations through `0007_unisender_event_dump_release.sql`.
- Only certification traffic: three orders, three fully refunded 1 ₽ payments, three successful refunds and fulfilled refund obligations, three cancelled bookings/void tickets, three applied provider webhooks; nine delivered emails and nine consumed dumps. Zero real leads, partner operations, rewards, payouts, and ORD records. One historical legal publication.
- External tails: closed (ART-156). These historical observations are not a substitute for a fresh F9.1 execution.

## Fresh cutover gate

Run the same script after verifying the freeze and external obligations, compare identity/query hash and aggregates, and stop on any new non-certification data or open obligations. Store only aggregate-safe evidence. The immutable v1 archive remains insurance, not a migration/backfill source.
