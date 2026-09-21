import { describe, expect, it } from "vitest";
import { DockerComposeRollbackEvidence, type DockerCommand } from "../../src/release/compose-rollback-evidence";

const PREDECESSOR = "a".repeat(40);
const SUCCESSOR = "b".repeat(40);
const application = { id: "3", uuid: "compose-application", name: "commerce", buildPack: "dockercompose", gitBranch: "production-deploy", gitCommitSha: PREDECESSOR };
const commerce = `registry.example/commerce:${PREDECESSOR}`;
const worker = `registry.example/commerce-worker:${PREDECESSOR}`;

const command = (options: { images?: readonly string[]; retained?: Record<string, readonly string[]>; absent?: string } = {}): DockerCommand => async (args) => {
  const [noun, verb] = args;
  if (noun === "ps") return "commerce\nworker\n";
  if (noun === "inspect") return `${(options.images ?? [commerce, worker]).join("\n")}\n`;
  if (noun === "image" && verb === "inspect") {
    if (args[2] === options.absent) throw new Error("not found");
    return "{}\n";
  }
  if (noun === "image" && verb === "ls") {
    const repository = args[2];
    return `${(options.retained?.[repository] ?? [
      `${repository}:${PREDECESSOR}`,
      `${repository}:${SUCCESSOR}`,
    ]).join("\n")}\n`;
  }
  throw new Error(`unexpected docker command: ${args.join(" ")}`);
};

describe("Compose rollback admission", () => {
  it("requires every running Compose service to retain the exact predecessor and one additional image", async () => {
    await expect(new DockerComposeRollbackEvidence(command()).assertRecoverable(application, PREDECESSOR)).resolves.toBeUndefined();
  });

  it("refuses a container whose tag is not the exact predecessor", async () => {
    const evidence = new DockerComposeRollbackEvidence(command({ images: [commerce, `registry.example/commerce-worker:${SUCCESSOR}`] }));
    await expect(evidence.assertRecoverable(application, PREDECESSOR)).rejects.toMatchObject({
      code: "COMPOSE_ROLLBACK_PREDECESSOR_TAG_MISMATCH",
    });
  });

  it("refuses when either Compose service lacks its local predecessor image", async () => {
    const evidence = new DockerComposeRollbackEvidence(command({ absent: worker }));
    await expect(evidence.assertRecoverable(application, PREDECESSOR)).rejects.toMatchObject({
      code: "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING",
    });
  });

  it("refuses one-image retention even though the predecessor image exists", async () => {
    const evidence = new DockerComposeRollbackEvidence(command({ retained: {
      "registry.example/commerce": [commerce],
      "registry.example/commerce-worker": [worker],
    } }));
    await expect(evidence.assertRecoverable(application, PREDECESSOR)).rejects.toMatchObject({
      code: "COMPOSE_ROLLBACK_RETENTION_INSUFFICIENT",
    });
  });
});
