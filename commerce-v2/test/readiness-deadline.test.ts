import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { migrateV2 } from "../src/db";
import type { ErasureRuntimeFence } from "../src/erasure-fence";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { READINESS_DEADLINE_MS } from "../src/readiness";

// Only ready() is reachable from /readyz; admission middleware skips the path.
const app = (ready: () => Promise<boolean>) => {
  const db = new Database(":memory:"); migrateV2(db);
  return createCommerceV2App({ db, erasureFence: { ready } as unknown as ErasureRuntimeFence,
    config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" }), sourceCommit: "a".repeat(40),
    serviceToken: "private-service-token" });
};
const after = <T,>(ms: number, value: () => T) => new Promise<T>((resolve, reject) =>
  setTimeout(() => { try { resolve(value()); } catch (error) { reject(error); } }, ms));
afterEach(() => { vi.useRealTimers(); });

describe("Commerce readiness deadline", () => {
  it.each([11_000, 18_000])("answers a still-running %ims authority read as unverified within the deadline", async readMs => {
    vi.useFakeTimers();
    const ready = vi.fn(() => after(readMs, () => true));
    let answered = false;
    const response = Promise.resolve(app(ready).request("/readyz")).then(value => { answered = true; return value; });
    await vi.advanceTimersByTimeAsync(READINESS_DEADLINE_MS);
    expect(answered).toBe(true);
    const result = await response;
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ ok: false, capabilities: { erasure: "unverified" } });
    // The read is neither cancelled nor cached: it completes on its own, once.
    await vi.advanceTimersByTimeAsync(readMs);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("still reports an authority read that completes inside the deadline", async () => {
    vi.useFakeTimers();
    const response = app(() => after(READINESS_DEADLINE_MS - 1_000, () => true)).request("/readyz");
    await vi.advanceTimersByTimeAsync(READINESS_DEADLINE_MS);
    expect(await (await response).json()).toMatchObject({ capabilities: { erasure: "qualified" } });
  });

  it("observes a late failing read instead of leaving an unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const response = app(() => after(READINESS_DEADLINE_MS + 5_000, () => { throw new Error("LATE_READ_FAILURE"); })).request("/readyz");
      await vi.advanceTimersByTimeAsync(READINESS_DEADLINE_MS);
      expect((await response).status).toBe(503);
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});
