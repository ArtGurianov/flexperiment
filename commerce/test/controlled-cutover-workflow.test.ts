import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-age-band-cutover.yml", "utf8");
const deployHelper = readFileSync("scripts/controlled-coolify-deploy.sh", "utf8");
const adminDescriptor = readFileSync("apps/admin/scripts/write-release-descriptor.mjs", "utf8");
const frontendDockerfile = readFileSync("Dockerfile.frontend", "utf8");

describe("controlled cutover production topology", () => {
  it("uses the three authenticated manual deployment targets and split public origins", () => {
    expect(workflow).toContain("COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL");
    expect(workflow).toContain("COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL");
    expect(workflow).toContain("COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL");
    expect(workflow).toContain("PUBLIC_FRONTEND_URL/release.json");
    expect(workflow).toContain("PUBLIC_API_URL/v1/public/legal-config");
    expect(workflow).not.toContain("COOLIFY_DEPLOY_WEBHOOK_URL:");
    expect(workflow).not.toContain("PUBLIC_RELEASE_URL");
    expect(workflow).not.toContain("PROMOTION_REF");
  });

  it("keeps the candidate-derived release identity through reruns, promotion, and completion", () => {
    expect(workflow).toContain("RELEASE_ID: age-band-${{ inputs.target_sha }}");
    expect(workflow).not.toContain("RELEASE_ID: gha-${{ github.run_id }}");
    expect(workflow).toContain('api "$PUBLIC_API_URL/v1/internal/release-control/completion/$RELEASE_ID"');
    expect(workflow).toContain('[[ "$owner" == "$RELEASE_ID" ]]');
    expect(workflow).toContain('RELEASE_ID="$RELEASE_ID" COMMERCE_RELEASE_MANIFEST_PATH=commerce/legal/production-manifest.json pnpm exec tsx commerce/src/release-cutover-payload.ts "$PROMOTION_SHA"');
  });

  it("keeps release payloads and reconciliations off pnpm lifecycle stdout", () => {
    expect(workflow).not.toContain("pnpm commerce:release-cutover:payload");
    expect(workflow).not.toContain("pnpm commerce:release-cutover:reconcile");
    expect(workflow.match(/pnpm exec tsx commerce\/src\/release-cutover-payload\.ts .* > (release|promotion-release)\.json/g)).toHaveLength(2);
    expect(workflow.match(/pnpm exec tsx commerce\/src\/reconcile-cutover\.ts .* > reconciliation\.json/g)).toHaveLength(3);
    expect(workflow.match(/CUTOVER_RECONCILIATION_INVALID_JSON/g)).toHaveLength(3);
  });

  it("does not emit pnpm lifecycle banners during candidate readiness retries", () => {
    expect(workflow).toContain("node --import tsx commerce/src/assert-candidate-runtime-ready.ts status.json");
    expect(workflow).not.toContain("pnpm commerce:release-cutover:assert-candidate-ready");
  });

  it("keeps main as the source ref while deploying candidate and promotion through the guarded ref", () => {
    expect(workflow).toContain("New release target must equal origin/main");
    expect(workflow).toContain("git push origin HEAD:refs/heads/main");
    expect(workflow).not.toContain("--force");
    expect(workflow).toContain("admin_contract_version == \"age-band-v1\"");
    expect(workflow).toContain("scripts/controlled-coolify-deploy.sh \"$TARGET_SHA\"");
    expect(workflow).toContain("scripts/controlled-coolify-deploy.sh \"$PROMOTION_SHA\"");
    const candidateRef = workflow.indexOf('scripts/set-production-deploy-ref.sh "$TARGET_SHA"');
    const candidateDeploy = workflow.indexOf('scripts/controlled-coolify-deploy.sh "$TARGET_SHA"');
    const promotionRef = workflow.indexOf('scripts/set-production-deploy-ref.sh "$PROMOTION_SHA"');
    const promotionDeploy = workflow.indexOf('scripts/controlled-coolify-deploy.sh "$PROMOTION_SHA"');
    expect(candidateRef).toBeGreaterThan(workflow.indexOf("Acquire owner and pause sales"));
    expect(candidateRef).toBeLessThan(candidateDeploy);
    expect(promotionRef).toBeGreaterThan(workflow.indexOf("Create or recover guarded promotion on main"));
    expect(promotionRef).toBeLessThan(promotionDeploy);
  });

  it("requires deploy-token authorization and never treats a webhook as runtime proof", () => {
    expect(deployHelper).toContain("Authorization: Bearer $COOLIFY_TOKEN");
    expect(deployHelper.match(/deploy \"\$COOLIFY_/g)).toHaveLength(3);
    expect(deployHelper).toContain("Configured production ref does not match");
    expect(deployHelper).toContain("only an enqueue acknowledgement");
  });

  it("generates immutable admin deployment evidence", () => {
    expect(adminDescriptor).toContain("admin_contract_version: \"age-band-v1\"");
    expect(adminDescriptor).toContain("SOURCE_COMMIT must be the exact 40-character");
  });

  it("uses a fail-closed static frontend build artifact", () => {
    expect(frontendDockerfile).toContain("ARG SOURCE_COMMIT");
    expect(frontendDockerfile).toContain("ENV SOURCE_COMMIT=${SOURCE_COMMIT}");
    expect(frontendDockerfile).toContain("COPY --from=build /app/out /usr/share/nginx/html");
  });
});
