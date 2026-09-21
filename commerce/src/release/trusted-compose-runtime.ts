import { execFile } from "node:child_process";

export class TrustedComposeRuntimeError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}
export type TrustedService = "commerce" | "commerce-worker";
export type TrustedComposeBinding = Readonly<{
  applicationUuid: string;
  resourceId: string;
  repositories: Readonly<Record<TrustedService, string>>;
}>;
export type TrustedComposeUnit = Readonly<{ id: string; service: TrustedService; image: string; running: boolean }>;
export type TrustedDockerCommand = (args: readonly string[]) => Promise<string>;
const docker: TrustedDockerCommand = (args) => new Promise((resolve, reject) => {
  execFile("docker", args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const services = new Set<TrustedService>(["commerce", "commerce-worker"]);

/** Docker authority is trusted Coolify binding plus labels and exact IDs; names never participate. */
export class TrustedComposeRuntimeControl {
  constructor(private readonly command: TrustedDockerCommand = docker) {}

  async capture(binding: TrustedComposeBinding, expectedSha: string): Promise<readonly TrustedComposeUnit[]> {
    this.validateInput(binding, expectedSha);
    const discovered = this.parseDiscovery(await this.run([
      "ps", "-a", "--no-trunc", "--filter", `label=coolify.applicationId=${binding.resourceId}`,
      "--format", '{{.ID}}|{{.Label "com.docker.compose.service"}}',
    ], "TRUSTED_COMPOSE_DISCOVERY_FAILED"));
    this.assertExactPair(discovered);
    const inspected = this.parseInspection(await this.run([
      "inspect", "--format", '{{.Id}}|{{.Config.Image}}|{{.State.Running}}|{{index .Config.Labels "coolify.applicationId"}}|{{index .Config.Labels "com.docker.compose.service"}}',
      ...discovered.map((unit) => unit.id),
    ], "TRUSTED_COMPOSE_INSPECT_FAILED"));
    if (inspected.length !== discovered.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_CONTAINER_DISAPPEARED");
    this.assertExactPair(inspected);
    const discoveredById = new Map(discovered.map((unit) => [unit.id, unit.service] as const));
    for (const unit of inspected) {
      if (discoveredById.get(unit.id) !== unit.service) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_CONTAINER_DRIFT");
      if (unit.applicationId !== binding.resourceId) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_FOREIGN_APPLICATION");
      const { repository, tag } = splitImage(unit.image);
      if (repository !== binding.repositories[unit.service]) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_IMAGE_REPOSITORY_MISMATCH", unit.service);
      if (tag !== expectedSha || !/^[a-f0-9]{40}$/.test(tag)) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_IMAGE_SHA_MISMATCH", unit.service);
    }
    return inspected.map(({ id, service, image, running }) => ({ id, service, image, running }));
  }

  async stopAndReprove(binding: TrustedComposeBinding, captured: readonly TrustedComposeUnit[]): Promise<void> {
    this.assertExactPair(captured);
    const live = captured.filter((unit) => unit.running).map((unit) => unit.id);
    if (live.length) await this.run(["stop", ...live], "TRUSTED_COMPOSE_STOP_FAILED");
    await this.assertStopped(binding, captured);
  }

  async assertStopped(binding: TrustedComposeBinding, captured: readonly TrustedComposeUnit[]): Promise<void> {
    this.validateCaptured(binding, captured);
    const states = lines(await this.run(["inspect", "--format", "{{.Id}}|{{.State.Running}}", ...captured.map((unit) => unit.id)], "TRUSTED_COMPOSE_CAPTURED_ID_DRIFT"));
    if (states.length !== captured.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_CONTAINER_DISAPPEARED");
    const stateById = new Map(states.map((line) => { const [id, state, ...extra] = line.split("|"); if (!id || !state || extra.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_METADATA_INVALID"); return [id, state] as const; }));
    if (captured.some((unit) => stateById.get(unit.id) !== "false")) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_CAPTURED_STILL_RUNNING");
    const running = this.parseDiscovery(await this.run([
      "ps", "--no-trunc", "--filter", `label=coolify.applicationId=${binding.resourceId}`,
      "--format", '{{.ID}}|{{.Label "com.docker.compose.service"}}',
    ], "TRUSTED_COMPOSE_REPROOF_FAILED"));
    if (running.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_NEW_RUNTIME_DRIFT");
  }

  async startCaptured(binding: TrustedComposeBinding, captured: readonly TrustedComposeUnit[]): Promise<void> {
    this.validateCaptured(binding, captured);
    await this.run(["start", ...captured.map((unit) => unit.id)], "TRUSTED_COMPOSE_START_FAILED");
    const states = lines(await this.run(["inspect", "--format", "{{.Id}}|{{.State.Running}}", ...captured.map((unit) => unit.id)], "TRUSTED_COMPOSE_START_REPROOF_FAILED"));
    if (states.length !== captured.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_CONTAINER_DISAPPEARED");
    const stateById = new Map(states.map((line) => { const [id, state, ...extra] = line.split("|"); if (!id || !state || extra.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_METADATA_INVALID"); return [id, state] as const; }));
    if (captured.some((unit) => stateById.get(unit.id) !== "true")) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_START_INCOMPLETE");
  }

  private validateInput(binding: TrustedComposeBinding, sha: string) {
    if (!binding.applicationUuid || !/^\d+$/.test(binding.resourceId) || !/^[a-f0-9]{40}$/.test(sha)
      || !binding.repositories.commerce || !binding.repositories["commerce-worker"]) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_INPUT_INVALID");
  }
  private assertExactPair(units: readonly { service: TrustedService }[]) {
    if (units.length !== 2 || new Set(units.map((unit) => unit.service)).size !== 2) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_UNITS_INVALID");
  }
  private validateCaptured(binding: TrustedComposeBinding, units: readonly TrustedComposeUnit[]) {
    this.assertExactPair(units);
    for (const unit of units) {
      const { repository } = splitImage(unit.image);
      if (!validId(unit.id) || repository !== binding.repositories[unit.service]) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_CAPTURE_INVALID");
    }
  }
  private parseDiscovery(value: string): { id: string; service: TrustedService }[] {
    return lines(value).map((line) => { const [id, service, ...extra] = line.split("|"); if (!validId(id) || !services.has(service as TrustedService) || extra.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_METADATA_INVALID"); return { id: id!, service: service as TrustedService }; });
  }
  private parseInspection(value: string): Array<TrustedComposeUnit & { applicationId: string }> {
    return lines(value).map((line) => { const [id, image, state, applicationId, service, ...extra] = line.split("|"); if (!validId(id) || !image || (state !== "true" && state !== "false") || !applicationId || !services.has(service as TrustedService) || extra.length) throw new TrustedComposeRuntimeError("TRUSTED_COMPOSE_METADATA_INVALID"); return { id: id!, image, running: state === "true", applicationId, service: service as TrustedService }; });
  }
  private async run(args: readonly string[], code: string): Promise<string> { try { return await this.command(args); } catch { throw new TrustedComposeRuntimeError(code); } }
}

const validId = (id: string | undefined) => /^[a-f0-9]{12,64}$/i.test(id ?? "");
const splitImage = (image: string) => { const at = image.lastIndexOf(":"); return at <= 0 ? { repository: "", tag: "" } : { repository: image.slice(0, at), tag: image.slice(at + 1) }; };
