import { execFile } from "node:child_process";

export class DockerComposeRuntimeError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

export type DockerRuntimeCommand = (args: readonly string[]) => Promise<string>;

const docker: DockerRuntimeCommand = (args) => new Promise((resolve, reject) => {
  execFile("docker", args, { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const expectedServices = new Set(["commerce", "commerce-worker"]);

/**
 * Stops the two Compose services as one bounded operation and reads their
 * state back. The resource ID comes from the trusted Coolify server-resource
 * binding; it is never a free-form host configuration value.
 */
export class DockerComposeRuntimeControl {
  constructor(private readonly command: DockerRuntimeCommand = docker) {}

  async ensureStopped(applicationId: string): Promise<void> {
    const containers = await this.containers(applicationId);
    await this.run(["stop", ...containers], "COMPOSE_RUNTIME_STOP_FAILED");
    const states = lines(await this.run(["inspect", "--format", "{{.State.Running}}", ...containers], "COMPOSE_RUNTIME_QUIESCENCE_UNREADABLE"));
    if (states.length !== containers.length || states.some((state) => state !== "false")) {
      throw new DockerComposeRuntimeError("COMPOSE_RUNTIME_NOT_QUIESCENT", applicationId);
    }
  }

  async assertRunning(applicationId: string): Promise<void> {
    const containers = await this.containers(applicationId);
    const states = lines(await this.run(["inspect", "--format", "{{.State.Running}}", ...containers], "COMPOSE_RUNTIME_QUIESCENCE_UNREADABLE"));
    if (states.length !== containers.length || states.some((state) => state !== "true")) {
      throw new DockerComposeRuntimeError("COMPOSE_RUNTIME_NOT_RUNNING", applicationId);
    }
  }

  private async containers(applicationId: string): Promise<readonly string[]> {
    if (!/^\d+$/.test(applicationId)) throw new DockerComposeRuntimeError("COMPOSE_RUNTIME_APPLICATION_ID_INVALID");
    const values = lines(await this.run(
      ["ps", "-a", "--filter", `label=coolify.applicationId=${applicationId}`, "--format", '{{.ID}}|{{.Label "com.docker.compose.service"}}'],
      "COMPOSE_RUNTIME_CONTAINER_DISCOVERY_FAILED",
    ));
    const parsed = values.map((value) => value.split("|"));
    const ids = parsed.map(([id, service, ...rest]) => {
      if (!id || !service || rest.length) throw new DockerComposeRuntimeError("COMPOSE_RUNTIME_CONTAINER_METADATA_INCOMPLETE", applicationId);
      return { id, service };
    });
    const services = new Set(ids.map((item) => item.service));
    if (ids.length !== expectedServices.size || services.size !== expectedServices.size || [...expectedServices].some((service) => !services.has(service))) {
      throw new DockerComposeRuntimeError("COMPOSE_RUNTIME_CONTAINERS_MISSING", applicationId);
    }
    return ids.map((item) => item.id);
  }

  private async run(args: readonly string[], code: string): Promise<string> {
    try { return await this.command(args); }
    catch { throw new DockerComposeRuntimeError(code); }
  }
}
