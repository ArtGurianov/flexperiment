import { describe, expect, it } from "vitest";
import { DockerComposeRollbackEvidence, type DockerCommand } from "../../src/release/compose-rollback-evidence";

const PREDECESSOR = "a".repeat(40);
const SUCCESSOR = "b".repeat(40);
const commerce = `registry.example/commerce:${PREDECESSOR}`;
const worker = `registry.example/commerce-worker:${PREDECESSOR}`;

const command = (options: { images?: readonly string[]; absent?: string; services?: string } = {}): DockerCommand => async (args) => {
  const [noun, verb] = args;
  if (noun === "ps") return options.services ?? "commerce-id|commerce\nworker-id|commerce-worker\n";
  if (noun === "inspect") return `${(options.images ?? [commerce, worker]).join("\n")}\n`;
  if (noun === "image" && verb === "inspect") {
    if (args[2] === options.absent) throw new Error("not found");
    return "{}\n";
  }
  throw new Error(`unexpected docker command: ${args.join(" ")}`);
};

describe("Compose rollback host evidence", () => {
  it("accepts exactly one predecessor image per repository", async () => {
    await expect(new DockerComposeRollbackEvidence(command()).assertPreDeployRecoverable("3", PREDECESSOR)).resolves.toBeUndefined();
  });

  it("refuses a container whose tag is not the exact predecessor", async () => {
    const evidence = new DockerComposeRollbackEvidence(command({ images: [commerce, `registry.example/commerce-worker:${SUCCESSOR}`] }));
    await expect(evidence.assertPreDeployRecoverable("3", PREDECESSOR)).rejects.toMatchObject({
      code: "COMPOSE_ROLLBACK_PREDECESSOR_TAG_MISMATCH",
    });
  });

  it("refuses when either current Compose service lacks its local predecessor image", async () => {
    const evidence = new DockerComposeRollbackEvidence(command({ absent: worker }));
    await expect(evidence.assertPreDeployRecoverable("3", PREDECESSOR)).rejects.toMatchObject({
      code: "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING",
    });
  });

  it("refuses missing or duplicate current service containers", async () => {
    const evidence = new DockerComposeRollbackEvidence(command({ services: "commerce-id|commerce\nextra-id|commerce\n" }));
    await expect(evidence.assertPreDeployRecoverable("3", PREDECESSOR)).rejects.toMatchObject({
      code: "COMPOSE_ROLLBACK_CONTAINERS_MISSING",
    });
  });

  it("refuses after convergence when a predecessor image has disappeared", async () => {
    const evidence = new DockerComposeRollbackEvidence(command({
      images: [`registry.example/commerce:${SUCCESSOR}`, `registry.example/commerce-worker:${SUCCESSOR}`],
      absent: `registry.example/commerce-worker:${PREDECESSOR}`,
    }));
    await expect(evidence.assertPredecessorStillPresent("3", PREDECESSOR)).rejects.toMatchObject({
      code: "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING",
    });
  });
});
