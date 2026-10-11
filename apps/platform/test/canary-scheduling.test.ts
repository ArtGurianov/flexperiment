import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasePayload, type SanitizedConfig } from "payload";
import { canaryOrigins } from "../lib/canary-config";

const historicalAutoRun = [{ cron: "*/5 * * * *", queue: "default", limit: 50 }];

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries({
    ...canaryOrigins,
    PLATFORM_V2_CANARY: "true",
    COMMERCE_INTERNAL_ORIGIN: "http://xzuy7pk5y6ywjr9kh6nsk5ap:3002",
    PAYLOAD_DATABASE_URL: "file:/var/lib/flexperiment-platform-canary/platform.sqlite",
    PAYLOAD_JOBS_ENABLED: "false",
    PAYMENT_MODE: "disabled",
    MARKETING_BROADCASTS_ENABLED: "false",
    DEPLOY_ENV: "staging",
    PAYLOAD_SECRET: "synthetic-private-payload-secret-32bytes",
    PLATFORM_COMMERCE_SERVICE_TOKEN: "synthetic-canary-service-token-32bytes",
    BUILD_IDENTITY_FILE: "/app/.identity/identity.json",
    PLATFORM_EXPECTED_COMMERCE_SHA: "b".repeat(40),
    SOURCE_COMMIT: "a".repeat(40),
    S3_BUCKET: "",
  })) vi.stubEnv(key, value);
  // Exercise the runtime scheduler, not Payload's Next build short-circuit.
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("npm_lifecycle_event", undefined);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function runtimeConfig() {
  // Import the actual buildConfig/sanitization and canary selection, not a
  // handwritten jobs config. No Payload init, DB connection or network call.
  return await (await import("../payload.config")).default;
}

async function triggerRegisteredCrons(config: SanitizedConfig) {
  const payload = new BasePayload();
  payload.config = config;
  const scheduling = vi.spyOn(payload.jobs, "handleSchedules").mockResolvedValue({ errored: [], queued: [], skipped: [] });
  const execution = vi.spyOn(payload.jobs, "run").mockResolvedValue({ remainingJobsFromQueried: 0 });
  const errors = vi.fn();
  payload.logger = { error: errors } as unknown as BasePayload["logger"];
  // Real installed Payload + Croner. Spy only the side-effect boundaries; do
  // not init a database or run application tasks. Always stop real timers.
  try {
    await payload._initializeCrons();
    for (const cron of payload.crons) {
      cron.pause();
      await cron.trigger();
    }
    expect(errors).not.toHaveBeenCalled();
    return { registered: payload.crons.length, scheduling, execution };
  } finally {
    for (const cron of payload.crons) cron.stop();
  }
}

function assertNoAutomaticWork(result: Awaited<ReturnType<typeof triggerRegisteredCrons>>) {
  expect(result.registered).toBe(0);
  expect(result.scheduling).not.toHaveBeenCalled();
  expect(result.execution).not.toHaveBeenCalled();
}

describe("closed Platform canary automatic scheduling", () => {
  it("registers no cron and neither schedules nor runs, with real sanitized config", async () => {
    const config = await runtimeConfig();
    expect(config.jobs.enabled).toBe(true);
    expect(config.jobs.scheduling).toBe(true); // The scheduled task remains defined.
    expect(config.jobs.tasks?.map(task => task.slug)).toEqual(["syncCourseManifest", "reconcileCourseManifests", "schedulePublish"]);
    expect(config.jobs.tasks?.[1].schedule).toEqual([{ cron: "*/5 * * * *", queue: "default" }]);
    assertNoAutomaticWork(await triggerRegisteredCrons(config));
    expect(config.jobs.autoRun).toEqual([]);
  });

  it("causal control detects the historical autoRun: scheduling precedes false shouldAutoRun", async () => {
    const config = await runtimeConfig();
    config.jobs.autoRun = historicalAutoRun;
    const result = await triggerRegisteredCrons(config);
    expect(result.registered).toBe(1);
    expect(result.scheduling).toHaveBeenCalledExactlyOnceWith({ allQueues: undefined, queue: "default" });
    expect(result.execution).not.toHaveBeenCalled();
    expect(() => assertNoAutomaticWork(result)).toThrow();
  });

  it.each([undefined, "false"])("non-canary flag %s preserves cron and scheduling with disabled execution", async flag => {
    vi.stubEnv("PLATFORM_V2_CANARY", flag);
    const config = await runtimeConfig();
    expect(config.jobs.autoRun).toEqual(historicalAutoRun);
    const result = await triggerRegisteredCrons(config);
    expect(result.registered).toBe(1);
    expect(result.scheduling).toHaveBeenCalledExactlyOnceWith({ allQueues: undefined, queue: "default" });
    expect(result.execution).not.toHaveBeenCalled();
  });

  it("non-canary enabled execution preserves both scheduling and default queue/limit", async () => {
    vi.stubEnv("PLATFORM_V2_CANARY", "false");
    vi.stubEnv("PAYLOAD_JOBS_ENABLED", undefined);
    const config = await runtimeConfig();
    expect(config.jobs.autoRun).toEqual(historicalAutoRun);
    const result = await triggerRegisteredCrons(config);
    expect(result.scheduling).toHaveBeenCalledOnce();
    expect(result.execution).toHaveBeenCalledExactlyOnceWith({
      allQueues: undefined, limit: 50, queue: "default", silent: undefined,
    });
    expect(result.scheduling.mock.invocationCallOrder[0]).toBeLessThan(result.execution.mock.invocationCallOrder[0]);
  });
});
