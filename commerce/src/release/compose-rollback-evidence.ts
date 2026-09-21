import { execFile } from "node:child_process";
import type { CoolifyApplication } from "./coolify";

export class ComposeRollbackEvidenceError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type DockerCommand = (args: readonly string[]) => Promise<string>;

export interface ComposeRollbackEvidence {
  assertRecoverable(application: CoolifyApplication, predecessorSha: string): Promise<void>;
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
const COMMIT_TAG = /^[a-f0-9]{40}$/;

/**
 * Coolify's image API is authoritative for Dockerfile applications. A Compose
 * application is different: its retained images are per service on the host,
 * so proving only the resource-level API list could call a missing worker
 * image recoverable. This adapter checks every currently running service.
 */
export class DockerComposeRollbackEvidence implements ComposeRollbackEvidence {
  constructor(private readonly command: DockerCommand = docker) {}

  async assertRecoverable(application: CoolifyApplication, predecessorSha: string): Promise<void> {
    if (!application.id) throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_APPLICATION_ID_MISSING", application.uuid);

    const containers = lines(await this.run(
      ["ps", "--filter", `label=coolify.applicationId=${application.id}`, "--format", "{{.ID}}"],
      "COMPOSE_ROLLBACK_CONTAINER_DISCOVERY_FAILED",
    ));
    if (!containers.length) throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_CONTAINERS_MISSING", application.uuid);

    const images = lines(await this.run(
      ["inspect", "--format", "{{.Config.Image}}", ...containers],
      "COMPOSE_ROLLBACK_CONTAINER_INSPECTION_FAILED",
    ));
    if (images.length !== containers.length) {
      throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_CONTAINER_IMAGE_INCOMPLETE", application.uuid);
    }
    if (images.some((image) => tagOf(image) !== predecessorSha)) {
      throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_PREDECESSOR_TAG_MISMATCH", application.uuid);
    }

    for (const image of new Set(images)) {
      await this.run(["image", "inspect", image], "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING");
      const repository = repositoryOf(image);
      const retained = new Set(lines(await this.run(
        ["image", "ls", repository, "--format", "{{.Repository}}:{{.Tag}}"],
        "COMPOSE_ROLLBACK_RETENTION_UNREADABLE",
      )).filter((candidate) => repositoryOf(candidate) === repository && COMMIT_TAG.test(tagOf(candidate))));
      if (!retained.has(image) || retained.size < 2) {
        throw new ComposeRollbackEvidenceError("COMPOSE_ROLLBACK_RETENTION_INSUFFICIENT", `${repository}: ${retained.size}`);
      }
    }
  }

  private async run(args: readonly string[], code: string): Promise<string> {
    try { return await this.command(args); }
    catch { throw new ComposeRollbackEvidenceError(code); }
  }
}
