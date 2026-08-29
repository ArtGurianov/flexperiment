import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-sales-availability-cutover.yml", "utf8");

describe("controlled sales-availability v1 cutover workflow", () => {
  it("is manual, serialized with production, and keeps controller and source identities distinct", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("options: [prepare, certify, classify_runtime_readiness_defect, complete]");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("CONTROLLER_SHA: ${{ github.sha }}");
    expect(workflow).toContain("PRODUCTION_DEPLOY_REF_TOKEN: ${{ secrets.PRODUCTION_DEPLOY_REF_TOKEN }}");
    expect(workflow).toContain("INPUT_TARGET_SHA: ${{ inputs.target_sha }}");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_DEPLOY_REF_TOKEN_REQUIRED");
    expect(workflow).toContain("git merge-base --is-ancestor \"$target_sha\" \"$CONTROLLER_SHA\"");
    expect(workflow).toContain("RELEASE_ID=sales-availability-v1:$target_sha");
  });

  /**
   * The candidate must carry the reconciled shared migrationApplied()
   * predicate. Without this pin a runtime built from a pre-reconciliation tree
   * would silently reinstate the run-33139603447 reopen defect in production.
   */
  it("pins the runtime to a source containing the reconciled migration-applied predicate", () => {
    expect(workflow).toContain("AUTHORITY_HEAD_MIN_SHA=0d31dbb35fa62f06c9e7378d49b6312678b5118f");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_AUTHORITY_HEAD_RUNTIME_REQUIRED");
  });

  it("binds the source to the sales-availability surface and to both new migrations", () => {
    expect(workflow).toContain('checkout_contract_version == "sales-availability-v1"');
    expect(workflow).toContain('admin_contract_version == "sales-availability-v1"');
    expect(workflow).toContain('has("0037_emergency_sales_gate.sql")');
    expect(workflow).toContain('has("0038_occurrence_availability_notifications.sql")');
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_MIGRATION_0037_MISSING");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_MIGRATION_0038_MISSING");
    expect(workflow).toContain("SALES_AVAILABILITY_MIGRATION_INVENTORY");
  });

  it("keeps every applied migration an append-only, byte-identical prefix of production", () => {
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_PRODUCTION_MIGRATION_SOURCE_MISMATCH");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_APPLIED_MIGRATION_NAMES_NOT_PREFIX");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_APPLIED_MIGRATION_BYTES_CHANGED");
    expect(workflow).toContain("production_migration_names");
    expect(workflow).toContain("candidate_applied_prefix");
    expect(workflow).toContain('git diff --no-ext-diff --name-status "$production_source" "$EFFECTIVE_TARGET_SHA" -- commerce/migrations');
    expect(workflow).toContain('awk \'NF > 0 && $1 != "A" { exit 1 }\'');
  });

  /**
   * Epoch A ships the notification code dormant. Only Epoch B's promotion
   * artifact may activate the purpose, so this controller proves from the
   * source that neither the active manifest nor the current legal copies moved.
   */
  it("refuses a candidate that would activate the notification purpose early", () => {
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_ACTIVE_MANIFEST_ALREADY_PROMOTED");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_DRAFT_MANIFEST_INVALID");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_CURRENT_LEGAL_COPIES_CHANGED");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_LEGAL_BASELINE_ALREADY_PROMOTED");
    expect(workflow).toContain('.publish_time == "PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP"');
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_NOTIFICATIONS_UNEXPECTEDLY_ACTIVE");
  });

  it("proves the deployed candidate serves the new public contract while still paused", () => {
    expect(workflow).toContain("/v1/public/tour");
    expect(workflow).toContain('map(has("purchase_status")) | all');
    expect(workflow).toContain('map(.purchase_status == "TEMPORARILY_PAUSED") | all');
    expect(workflow).toContain("/v1/public/legal-config");
    expect(workflow).toContain(".occurrence_notifications_available == false");
    expect(workflow).toContain("SALES_TEMPORARILY_PAUSED");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_RUNTIME_NOT_READY");
  });

  it("advances the deployment pointer only through the guarded CAS helpers", () => {
    expect(workflow).toContain("scripts/set-production-deploy-ref.sh \"$EFFECTIVE_TARGET_SHA\"");
    expect(workflow).toContain("scripts/controlled-coolify-deploy.sh \"$EFFECTIVE_TARGET_SHA\"");
    expect(workflow).not.toContain("git push --force ");
  });

  /**
   * certify holds the release-control token in the workflow rather than an
   * operator shell, so the evidence POST gets the same state-hash CAS and
   * replay reconciliation as every other transition.
   */
  it("records certification evidence only from a consumed in-flight lease", () => {
    expect(workflow).toContain("certification_order_id:");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_CERTIFICATION_ORDER_ID_INVALID");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_CERTIFY_INPUTS_FORBIDDEN");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_CERTIFY_STATE_INVALID");
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_CERTIFY_TRANSITION_INVALID");
    expect(workflow).toContain('.head.phase == "CERTIFICATION_IN_FLIGHT"');
    expect(workflow).toContain("candidates/certification/certify");
    // A replay after success must reconcile, not repost evidence.
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_ALREADY_CERTIFIED");
  });

  it("completes only a certified candidate and never publishes legal content", () => {
    expect(workflow).toContain("SALES_AVAILABILITY_CUTOVER_COMPLETE_STATE_INVALID");
    expect(workflow).toContain('.head.phase == "CERTIFIED" and .head.certification.status == "CONSUMED"');
    expect(workflow).toContain("candidates/complete");
    // Epoch A is code-only: legal publication and promotion belong to Epoch B.
    expect(workflow).not.toContain("release-control/legal-publish");
    expect(workflow).not.toContain("release-control/expectations");
    expect(workflow).not.toContain("release-control/reopen");
  });
});
