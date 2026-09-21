import { describe, expect, it } from "vitest";
import { DockerComposeRuntimeControl } from "../../src/release/docker-compose-runtime";

const runtime = (answers: Partial<Record<string, string>> = {}) => {
  const calls: string[][] = [];
  const command = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "ps") return answers.ps ?? "c1|commerce\nc2|commerce-worker\n";
    if (args[0] === "stop") return answers.stop ?? "c1\nc2\n";
    if (args[0] === "inspect") return answers.inspect ?? "false\nfalse\n";
    throw new Error("unexpected");
  };
  return { calls, control: new DockerComposeRuntimeControl(command) };
};

describe("Compose runtime quiescence", () => {
  it("stops commerce and worker in one command, then proves both stopped", async () => {
    const { calls, control } = runtime();
    await control.ensureStopped("3");
    expect(calls.map((call) => call[0])).toEqual(["ps", "stop", "inspect"]);
    expect(calls[1]).toEqual(["stop", "c1", "c2"]);
  });

  it("refuses a partial service set or a container that remains live", async () => {
    await expect(runtime({ ps: "c1|commerce\n" }).control.ensureStopped("3")).rejects.toMatchObject({ code: "COMPOSE_RUNTIME_CONTAINERS_MISSING" });
    await expect(runtime({ inspect: "false\ntrue\n" }).control.ensureStopped("3")).rejects.toMatchObject({ code: "COMPOSE_RUNTIME_NOT_QUIESCENT" });
  });

  it("does not accept a free-form nonnumeric Coolify label id", async () => {
    await expect(runtime().control.ensureStopped("app-commerce")).rejects.toMatchObject({ code: "COMPOSE_RUNTIME_APPLICATION_ID_INVALID" });
  });
});
