import { describe, expect, it } from "vitest";
import {
  TrustedComposeRuntimeControl,
  type TrustedComposeBinding,
  type TrustedComposeUnit,
} from "../../src/release/trusted-compose-runtime";

const SHA = "a".repeat(40);
const COMMERCE_ID = "1".repeat(64);
const WORKER_ID = "2".repeat(64);
const NEW_COMMERCE_ID = "3".repeat(64);
const binding: TrustedComposeBinding = {
  applicationUuid: "trusted-commerce-uuid",
  resourceId: "17",
  repositories: {
    commerce: "registry.example/flexperiment-commerce",
    "commerce-worker": "registry.example/flexperiment-commerce-worker",
  },
};

const discovery = (commerceId = COMMERCE_ID, workerId = WORKER_ID) =>
  `${commerceId}|commerce\n${workerId}|commerce-worker\n`;
const inspection = (options: {
  commerceId?: string;
  workerId?: string;
  commerceImage?: string;
  workerImage?: string;
  applicationId?: string;
  commerceRunning?: boolean;
  workerRunning?: boolean;
} = {}) => [
  `${options.commerceId ?? COMMERCE_ID}|${options.commerceImage ?? `registry.example/flexperiment-commerce:${SHA}`}|${options.commerceRunning ?? true}|${options.applicationId ?? "17"}|commerce`,
  `${options.workerId ?? WORKER_ID}|${options.workerImage ?? `registry.example/flexperiment-commerce-worker:${SHA}`}|${options.workerRunning ?? true}|${options.applicationId ?? "17"}|commerce-worker`,
].join("\n") + "\n";

const scripted = (responses: readonly { command: string; output?: string; error?: Error }[]) => {
  const calls: string[][] = [];
  const command = async (args: readonly string[]) => {
    calls.push([...args]);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`UNEXPECTED_DOCKER_CALL: ${args.join(" ")}`);
    expect(args.join(" ")).toBe(next.command);
    if (next.error) throw next.error;
    return next.output ?? "";
  };
  return { calls, control: new TrustedComposeRuntimeControl(command) };
};

const captureCommands = [
  `ps -a --no-trunc --filter label=coolify.applicationId=17 --format {{.ID}}|{{.Label "com.docker.compose.service"}}`,
  `inspect --format {{.Id}}|{{.Config.Image}}|{{.State.Running}}|{{index .Config.Labels "coolify.applicationId"}}|{{index .Config.Labels "com.docker.compose.service"}} ${COMMERCE_ID} ${WORKER_ID}`,
] as const;

const captureResponses = (inspect = inspection(), discovered = discovery()) => [
  { command: captureCommands[0], output: discovered },
  { command: captureCommands[1], output: inspect },
] as const;

describe("TrustedComposeRuntimeControl", () => {
  it("captures the exact trusted pair with full IDs and exact repositories/SHA", async () => {
    const { calls, control } = scripted(captureResponses());
    await expect(control.capture(binding, SHA)).resolves.toEqual([
      { id: COMMERCE_ID, service: "commerce", image: `registry.example/flexperiment-commerce:${SHA}`, running: true },
      { id: WORKER_ID, service: "commerce-worker", image: `registry.example/flexperiment-commerce-worker:${SHA}`, running: true },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("refuses missing and duplicate services", async () => {
    await expect(scripted([{ command: captureCommands[0], output: `${COMMERCE_ID}|commerce\n` }]).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_UNITS_INVALID" });
    await expect(scripted([{ command: captureCommands[0], output: `${COMMERCE_ID}|commerce\n${WORKER_ID}|commerce\n` }]).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_UNITS_INVALID" });
  });

  it("refuses a container whose inspect label belongs to another application", async () => {
    await expect(scripted(captureResponses(inspection({ applicationId: "99" }))).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_FOREIGN_APPLICATION" });
  });

  it("refuses the right SHA in the wrong repository", async () => {
    await expect(scripted(captureResponses(inspection({ commerceImage: `registry.example/other:${SHA}` }))).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_IMAGE_REPOSITORY_MISMATCH" });
  });

  it("refuses malformed or non-40-hex image tags", async () => {
    await expect(scripted(captureResponses(inspection({ commerceImage: "registry.example/flexperiment-commerce:latest" }))).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_IMAGE_SHA_MISMATCH" });
  });

  it("treats a container disappearing between list and inspect as drift", async () => {
    const one = inspection().split("\n")[0] + "\n";
    await expect(scripted(captureResponses(one)).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_CONTAINER_DISAPPEARED" });
  });

  it("refuses when a captured ID is running after stop", async () => {
    const captured = await scripted(captureResponses()).control.capture(binding, SHA);
    const { control } = scripted([
      { command: `stop ${COMMERCE_ID} ${WORKER_ID}` },
      { command: `inspect --format {{.Id}}|{{.State.Running}} ${COMMERCE_ID} ${WORKER_ID}`, output: `${COMMERCE_ID}|true\n${WORKER_ID}|false\n` },
    ]);
    await expect(control.stopAndReprove(binding, captured)).rejects.toMatchObject({ code: "TRUSTED_COMPOSE_CAPTURED_STILL_RUNNING" });
  });

  it("refuses a new running ID for a trusted service", async () => {
    const captured = await scripted(captureResponses()).control.capture(binding, SHA);
    const { control } = scripted([
      { command: `stop ${COMMERCE_ID} ${WORKER_ID}` },
      { command: `inspect --format {{.Id}}|{{.State.Running}} ${COMMERCE_ID} ${WORKER_ID}`, output: `${COMMERCE_ID}|false\n${WORKER_ID}|false\n` },
      { command: `ps --no-trunc --filter label=coolify.applicationId=17 --format {{.ID}}|{{.Label "com.docker.compose.service"}}`, output: `${NEW_COMMERCE_ID}|commerce\n` },
    ]);
    await expect(control.stopAndReprove(binding, captured)).rejects.toMatchObject({ code: "TRUSTED_COMPOSE_NEW_RUNTIME_DRIFT" });
  });

  it("retries a partial stop by stopping only the still-running captured ID", async () => {
    const captured: readonly TrustedComposeUnit[] = [
      { id: COMMERCE_ID, service: "commerce", image: `registry.example/flexperiment-commerce:${SHA}`, running: false },
      { id: WORKER_ID, service: "commerce-worker", image: `registry.example/flexperiment-commerce-worker:${SHA}`, running: true },
    ];
    const { calls, control } = scripted([
      { command: `stop ${WORKER_ID}` },
      { command: `inspect --format {{.Id}}|{{.State.Running}} ${COMMERCE_ID} ${WORKER_ID}`, output: `${COMMERCE_ID}|false\n${WORKER_ID}|false\n` },
      { command: `ps --no-trunc --filter label=coolify.applicationId=17 --format {{.ID}}|{{.Label "com.docker.compose.service"}}` },
    ]);
    await control.stopAndReprove(binding, captured);
    expect(calls[0]).toEqual(["stop", WORKER_ID]);
  });

  it("fails an unexpected Docker call/output immediately", async () => {
    const unexpected = new Error("UNEXPECTED_DOCKER_CALL: ps");
    await expect(scripted([{ command: captureCommands[0], error: unexpected }]).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_DISCOVERY_FAILED" });
    await expect(scripted([{ command: captureCommands[0], output: "not-json-or-metadata\n" }]).control.capture(binding, SHA))
      .rejects.toMatchObject({ code: "TRUSTED_COMPOSE_METADATA_INVALID" });
  });
});
