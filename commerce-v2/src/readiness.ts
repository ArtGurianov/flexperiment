import type Database from "better-sqlite3";
import { V2_SCHEMA_LINEAGE } from "./db";
import { closedPaidTestEnabled } from "../../lib/closed-paid-test-profile";

export type RefrefReadiness = "ready" | "unavailable" | "not_required";

/** /readyz answers within this, fresh erasure-authority read included (2026-10-22).
 * A read still running at the deadline is reported "unverified" (503). It is not
 * cancelled or cached: it finishes on its own and still closes admission itself if it
 * fails. Every outer probe waits strictly longer; scripts/v2/test_fast_cut.py pins the chain. */
export const READINESS_DEADLINE_MS = 8_000;

export async function withinDeadline<T>(work: Promise<T>, remainingMs: number): Promise<T | "DEADLINE"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"DEADLINE">(resolve => { timer = setTimeout(resolve, Math.max(0, remainingMs), "DEADLINE"); });
  // A rejection after the deadline is observed here instead of escaping as unhandled.
  work.catch(() => undefined);
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}
const MAX_RESPONSE_BYTES = 8192;

/** Ops GET only: no API credential, checkout, provider or tenant request. */
export function createRefrefReadinessProbe(environment: Readonly<Record<string, string | undefined>>, request = fetch) {
  const raw = environment.REFREF_READINESS_URL;
  if (!raw) throw new Error("REFREF_READINESS_URL_REQUIRED");
  const paidTest = closedPaidTestEnabled(environment);
  const expected = environment.DEPLOY_ENV === "production" || paidTest
    ? "https://ops.refref.ru/readyz" : "https://canary-ops.refref.ru/readyz";
  if (raw !== expected) throw new Error("REFREF_READINESS_URL_NOT_ALLOWED");
  return async (): Promise<RefrefReadiness> => {
    try {
      const response = await request(raw, {
        method: "GET", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(2000), headers: { accept: "application/json" },
      });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); return "unavailable"; }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return "unavailable"; }
        chunks.push(next.value);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return payload?.service === "refref-runtime" && payload.status === "READY"
        && /^[0-9a-f]{40}$/.test(payload.sourceCommit)
        && (!paidTest || payload.sourceCommit === environment.CLOSED_PAID_TEST_REFREF_SOURCE)
        && payload.checks && typeof payload.checks === "object" && !Array.isArray(payload.checks)
        && Object.keys(payload.checks).length > 0 && Object.values(payload.checks).every((value) => value === true)
        ? "ready" : "unavailable";
    } catch { return "unavailable"; }
  };
}

export function databaseReady(db: Database.Database): boolean {
  try {
    const identity = db.prepare("SELECT lineage FROM schema_identity WHERE singleton=1").get() as { lineage: string } | undefined;
    db.prepare("SELECT COUNT(*) FROM schema_migrations").get();
    db.prepare("SELECT 1 FROM catalog_course_projection LIMIT 1").get();
    db.prepare("SELECT 1 FROM access_overrides LIMIT 1").get();
    return identity?.lineage === V2_SCHEMA_LINEAGE;
  } catch { return false; }
}
