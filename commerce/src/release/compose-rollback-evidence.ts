import { execFile } from "node:child_process";

export class ComposeRollbackEvidenceError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type DockerCommand = (args: readonly string[]) => Promise<string>;

export interface ComposeRollbackEvidence {
  assertPreDeployRecoverable(applicationId: string, predecessorSha: string): Promise<void>;
  assertPredecessorStillPresent(applicationId: string, predecessorSha: string): Promise<void>;
}

const docker: DockerCommand = (args) => new Promise((resolve, reject) => {
  execFile("docker", args, { encoding: "utf8" }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const tagOf = (image: string) => image.slice(image.lastIndexOf(":") + 1);
const repositoryOf = (image: string) => image.slice(0, image.lastIndexOf(":"));
const expectedServices = new Set(["commerce", "commerce-worker"]);

type Container = { readonly id: string; readonly service: string };

/**
 * Compose services are individual local images. The pre-deploy check proves
 * the two current services are exactly the predecessor and their images exist.
 * Retention itself is a Coolify application/server policy, checked by the
 * deployment driver; counting old tags would prove neither policy and would
 * incorrectly reject the normal one-predecessor state before a target exists.
 */
export class DockerComposeRollbackEvidence implements ComposeRollbackEvidence {
  constructor(private readonly command: DockerCommand = docker) {}

  async assertPreDeployRecoverable(applicationId: string, predecessorSha: string): Promise<void> {
    const containers = await this.containers(applicationId);
    const images = await this.images(containers);
    if (images.some((image) => tagOf(image) !== predecessorSha)) {
      throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_PREDECESSOR_TAG_MISMATCH", applicationId);
    }
    await this.requireImages(images, "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING");
  }

  /**
   * Runs after the target has converged, before certification preflight can
   * arm external effects. It derives the two repositories from the current
   * target containers, then demands their predecessor tags are still local.
   */
  async assertPredecessorStillPresent(applicationId: string, predecessorSha: string): Promise<void> {
    const images = await this.images(await this.containers(applicationId));
    const predecessors = images.map((image) => `${repositoryOf(image)}:${predecessorSha}`);
    await this.requireImages(predecessors, "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING");
  }

  private async containers(applicationId: string): Promise<readonly Container[]> {
    if (!/^\d+$/.test(applicationId)) throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_APPLICATION_ID_INVALID");
    const values = lines(await this.run(
      ["ps", "--filter", `label=coolify.applicationId=${applicationId}`, "--format", '{{.ID}}|{{.Label "com.docker.compose.service"}}'],
      "COMPOSE_ROLLBACK_CONTAINER_DISCOVERY_FAILED",
    ));
    const containers = values.map((value) => {
      const [id, service, ...extra] = value.split("|");
      if (!id || !service || extra.length) throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_CONTAINER_METADATA_INCOMPLETE", applicationId);
      return { id, service };
    });
    const services = new Set(containers.map((container) => container.service));
    if (containers.length !== expectedServices.size || services.size !== expectedServices.size || [...expectedServices].some((service) => !services.has(service))) {
      throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_CONTAINERS_MISSING", applicationId);
    }
    return containers;
  }

  private async images(containers: readonly Container[]): Promise<readonly string[]> {
    const images = lines(await this.run(
      ["inspect", "--format", "{{.Config.Image}}", ...containers.map((container) => container.id)],
      "COMPOSE_ROLLBACK_CONTAINER_INSPECTION_FAILED",
    ));
    if (images.length !== containers.length || images.some((image) => !repositoryOf(image) || !tagOf(image))) {
      throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_CONTAINER_IMAGE_INCOMPLETE");
    }
    return images;
  }

  private async requireImages(images: readonly string[], code: string): Promise<void> {
    for (const image of new Set(images)) await this.run(["image", "inspect", image], code);
  }

  private async run(args: readonly string[], code: string): Promise<string> {
    try { return await this.command(args); }
    catch { throw new ComposeRollbackEvidenceError(code); }
  }
}
