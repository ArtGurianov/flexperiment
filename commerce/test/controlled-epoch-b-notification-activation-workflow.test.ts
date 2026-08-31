import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EPOCH_B_CANONICAL_MANIFEST_SHA256,
  EPOCH_B_DRAFT_PATH,
  EPOCH_B_RELEASE_ID,
  EPOCH_B_RUNTIME_R,
} from "../src/epoch-b-notification-activation";

const workflow = readFileSync(".github/workflows/controlled-epoch-b-notification-activation.yml", "utf8");
const policy = readFileSync("commerce/src/epoch-b-notification-activation.ts", "utf8");
const domain = readFileSync("commerce/src/domain.ts", "utf8");
const at = (needle: string) => {
  const index = workflow.indexOf(needle);
  expect(index, `workflow contains ${needle}`).toBeGreaterThan(-1);
  return index;
};

describe("controlled Epoch B notification activation", () => {
  it("is a manual production-gated controller with no caller-selected runtime or legal source", () => {
    const dispatch = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(dispatch).toContain("workflow_dispatch:");
    expect(dispatch).toContain("options: [prepare, complete]");
    expect(dispatch).not.toContain("target_sha:");
    expect(dispatch).not.toContain("legal_manifest");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain(`EPOCH_A_RUNTIME_SHA: ${EPOCH_B_RUNTIME_R}`);
    expect(workflow).toContain(`EPOCH_B_DRAFT_PATH: ${EPOCH_B_DRAFT_PATH}`);
    expect(workflow).toContain(`EPOCH_B_MANIFEST_SHA256: ${EPOCH_B_CANONICAL_MANIFEST_SHA256}`);
    expect(workflow).toContain(`EPOCH_B_RELEASE_ID: ${EPOCH_B_RELEASE_ID}`);
    expect(policy).toContain(`export const EPOCH_B_DRAFT_PATH = "${EPOCH_B_DRAFT_PATH}"`);
    expect(policy).toContain(`export const EPOCH_B_CANONICAL_MANIFEST_SHA256 = "${EPOCH_B_CANONICAL_MANIFEST_SHA256}"`);
  });

  it("uses the runtime legal-publish seam, then accepts a timestamp only from durable read-back", () => {
    const bindLegalB = at("Bind the paused R owner to exact legal-B publication expectations");
    const publish = at("Publish the literal reviewed legal B release under the paused owner");
    const readBack = at("Read durable B legal authority and construct deterministic P");
    const expectations = at("Bind the existing owner to exact P expectations");
    expect(bindLegalB).toBeLessThan(publish);
    expect(publish).toBeLessThan(readBack);
    expect(readBack).toBeLessThan(expectations);
    expect(workflow).toContain("/v1/internal/release-control/legal-publish");
    expect(workflow).toContain('api -X POST --data-binary @epoch-b-legal-request.json "$PUBLIC_API_URL/v1/internal/release-control/legal-publish"');
    expect(workflow).not.toContain("COMMERCE_LEGAL_MANIFEST_PATH");
    expect(workflow).toContain('expected: {source_commit: $r, migration: $migration, legal_version: $version, legal_manifest_sha256: $hash');
    expect(domain).toContain('const filename = `commerce/legal/production-manifest.${input.expected.legal_version}.draft.json`;');
    expect(domain).toContain("loadCanonicalLegalRelease(filename)");
    expect(workflow).toContain('effective_at="$(jq -er \' .runtime.legal_publish_time\' durable-after-publish.json)"'.replace("' ", "'"));
    expect(workflow).toContain("createEpochBPromotionArtifact({ base: process.env.EPOCH_A_RUNTIME_SHA, effectiveAt: process.env.EFFECTIVE_AT })");
    expect(workflow).toContain("EPOCH_B_DURABLE_LEGAL_STATUS_INVALID");
    expect(workflow).not.toContain("publish-legal-release.ts");
    expect(workflow).not.toContain("git checkout");
    expect(workflow).not.toContain("git worktree add");
  });

  it("retains the same owner across legal publication and makes P deterministic before expectations or CAS", () => {
    const freshAuthority = at("Reconfirm exact R and dormant notification authority before fresh acquire");
    const pause = at("Acquire Epoch B owner and pause sales before activation");
    const bindLegalB = at("Bind the paused R owner to exact legal-B publication expectations");
    const publicationProof = at("Prove same owner and pre-B authority before legal publication");
    const publish = at("Publish the literal reviewed legal B release under the paused owner");
    const construct = at("Read durable B legal authority and construct deterministic P");
    const expectations = at("Bind the existing owner to exact P expectations");
    const preCas = at("Reprove active legal and exact P owner immediately before CAS");
    const cas = at("CAS production-deploy from exact R to exact P");
    expect(freshAuthority).toBeLessThan(pause);
    expect(pause).toBeLessThan(bindLegalB);
    expect(bindLegalB).toBeLessThan(publicationProof);
    expect(publicationProof).toBeLessThan(publish);
    expect(publish).toBeLessThan(construct);
    expect(construct).toBeLessThan(expectations);
    expect(expectations).toBeLessThan(preCas);
    expect(preCas).toBeLessThan(cas);
    expect(policy).toContain("createEpochBPromotionArtifact");
    expect(policy).toContain("EPOCH_B_PROMOTION_NOT_DETERMINISTIC");
    expect(policy).toContain("EPOCH_B_PROMOTION_PARENT_MISMATCH");
    expect(policy).toContain("EPOCH_B_PROMOTION_CHANGED_SURFACE_UNEXPECTED");
    expect(workflow).toContain("EPOCH_B_FRESH_ACQUIRE_DURABLE_AUTHORITY_MISMATCH");
    expect(workflow).toContain("occurrence_notifications_available == false");
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$EPOCH_B_PROMOTION_SHA" "$EPOCH_A_RUNTIME_SHA"');
    expect(workflow).not.toContain("git push --force");
  });

  it("does not admit fresh adoption after legal B and never reopens during prepare", () => {
    expect(policy).toContain("EPOCH_B_FRESH_ADOPTION_FORBIDDEN");
    expect(policy).toContain("EPOCH_B_R_EXPECTATIONS_STATE_MISMATCH");
    expect(workflow).toContain("EPOCH_B_ACTIVATION_PREPARED=1");
    expect(workflow).toContain("occurrence_notifications_available == true");
    const reopen = at("Complete only after explicit GO and fresh active-P evidence");
    expect(workflow.slice(0, reopen)).not.toContain("/v1/internal/release-control/reopen");
    expect(workflow).toContain("env.INPUT_STAGE == 'complete' && env.EPOCH_B_ACTION == 'READY_TO_COMPLETE'");
  });

  it("reconstructs P for both prepared completion and pre-convergence recovery without classifying capability first", () => {
    const reconstruction = at("Reconstruct P only from durable active B timestamp when already published");
    const reconstructionEnd = workflow.indexOf("\n\n      - name:", reconstruction);
    const shell = workflow.slice(reconstruction, reconstructionEnd);
    expect(shell).toContain(".runtime.legal_publish_time");
    expect(shell).not.toContain("current_legal_copies_match == false");
    expect(shell).not.toContain("occurrence_notifications_available !== false");
    expect(policy).toContain("EPOCH_B_PRE_CAS_CAPABILITY_UNEXPECTED");
    expect(policy).toContain("EPOCH_B_P_EXPECTATIONS_POINTER_MISMATCH");
    expect(workflow).toContain("env.PRODUCTION_POINTER_BEFORE == env.EPOCH_A_RUNTIME_SHA");
  });

  it("does not use historical Epoch B branches as runtime authority", () => {
    expect(workflow).not.toContain("runtime-candidate");
    expect(workflow).not.toContain("codex/epoch-b-");
    expect(policy).not.toContain("runtime-candidate");
  });

  it("builds every Epoch B request from an empty stdin", () => {
    const constructors = [...workflow.matchAll(/^ {10}(jq -en[\s\S]*?\n {10}' > (epoch-[a-z-]+-request\.json))$/gm)];
    expect(constructors.map((match) => match[2])).toEqual([
      "epoch-a-request.json",
      "epoch-b-legal-request.json",
      "epoch-b-p-request.json",
      "epoch-b-p-request.json",
    ]);

    const directory = mkdtempSync(join(tmpdir(), "epoch-b-request-builders-"));
    const documentHashes = {
      privacy_policy: "a".repeat(64),
      pd_consent: "b".repeat(64),
    };
    const rManifestHash = "c".repeat(64);
    const promotionSha = "d".repeat(40);
    const migrationInput = "fixture";
    const migration = `inventory-sha256:${createHash("sha256").update(migrationInput).digest("hex")}`;
    const manifest = (version: string) => JSON.stringify({ version, documents: Object.fromEntries(Object.entries(documentHashes).map(([key, sha256]) => [key, { sha256 }])) });

    try {
      writeFileSync(join(directory, "r-production-manifest.json"), manifest("2026-08-26.1"));
      writeFileSync(join(directory, "epoch-b-draft.json"), manifest("2026-08-28.1"));
      writeFileSync(join(directory, "p-production-manifest.json"), manifest("2026-08-28.1"));
      writeFileSync(join(directory, "epoch-b-r-request.json"), JSON.stringify({ expected: { migration } }));

      const expectedRequests = [
        { releaseId: `epoch-a-dormant-notifications:${EPOCH_B_RUNTIME_R}`, sourceCommit: EPOCH_B_RUNTIME_R, legalVersion: "2026-08-26.1", legalManifestSha256: rManifestHash },
        { releaseId: EPOCH_B_RELEASE_ID, sourceCommit: EPOCH_B_RUNTIME_R, legalVersion: "2026-08-28.1", legalManifestSha256: EPOCH_B_CANONICAL_MANIFEST_SHA256 },
        { releaseId: EPOCH_B_RELEASE_ID, sourceCommit: promotionSha, legalVersion: "2026-08-28.1", legalManifestSha256: EPOCH_B_CANONICAL_MANIFEST_SHA256 },
        { releaseId: EPOCH_B_RELEASE_ID, sourceCommit: promotionSha, legalVersion: "2026-08-28.1", legalManifestSha256: EPOCH_B_CANONICAL_MANIFEST_SHA256 },
      ];

      constructors.forEach((match, index) => {
        const command = match[1];
        const output = match[2];
        const result = spawnSync("bash", ["-euo", "pipefail", "-c", `${command} </dev/null`], {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            EPOCH_A_RUNTIME_SHA: EPOCH_B_RUNTIME_R,
            EPOCH_A_RELEASE_ID: `epoch-a-dormant-notifications:${EPOCH_B_RUNTIME_R}`,
            EPOCH_B_RELEASE_ID,
            EPOCH_B_LEGAL_VERSION: "2026-08-28.1",
            EPOCH_B_MANIFEST_SHA256: EPOCH_B_CANONICAL_MANIFEST_SHA256,
            P_SHA: promotionSha,
            expected: migrationInput,
            r_manifest_hash: rManifestHash,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(directory, output), "utf8"))).toMatchObject({
          release_id: expectedRequests[index].releaseId,
          mode: "CONTROLLED_CUTOVER",
          expected: {
            source_commit: expectedRequests[index].sourceCommit,
            migration,
            legal_version: expectedRequests[index].legalVersion,
            legal_manifest_sha256: expectedRequests[index].legalManifestSha256,
            legal_hashes: documentHashes,
          },
        });
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
