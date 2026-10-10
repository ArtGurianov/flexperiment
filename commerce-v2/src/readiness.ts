import type Database from "better-sqlite3";
import { V2_SCHEMA_LINEAGE } from "./db";

export type RefrefReadiness = "ready" | "unavailable" | "not_required";
const MAX_RESPONSE_BYTES = 8192;

/** Ops GET only: no API credential, checkout, provider or tenant request. */
export function createRefrefReadinessProbe(environment: Readonly<Record<string, string | undefined>>, request = fetch) {
  const raw = environment.REFREF_READINESS_URL;
  if (!raw) throw new Error("REFREF_READINESS_URL_REQUIRED");
  const expected = environment.DEPLOY_ENV === "production"
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
