import type { Endpoint } from "payload";
import { hasAuthorCourse } from "./content/editorial";

type Summary = { accessModel: "FREE" | "PAID"; version: number; priceKopecks: number; saleMode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC"; withdrawn: boolean; offerRef: string };
const noStore = { "cache-control": "no-store" };
const author = (user: unknown): user is { id: string | number; collection: "users" } => Boolean(user && typeof user === "object"
  && "collection" in user && user.collection === "users" && "id" in user);
const reply = (code: string, status: number) => Response.json({ code }, { status, headers: noStore });

export async function freshCourseCommercial(courseRef: string): Promise<Summary | null> {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  if (!origin || !token) throw new Error("COMMERCE_NOT_CONFIGURED");
  const response = await fetch(new URL("/v1/internal/catalog-summary", origin), {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error("COMMERCE_UNAVAILABLE");
  const body = await response.json() as { courses?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.courses)) throw new Error("COMMERCE_RESULT_INVALID");
  const matches = body.courses.filter(row => row.courseRef === courseRef);
  if (matches.length > 1) throw new Error("COURSE_PRODUCT_AMBIGUOUS");
  const row = matches[0];
  if (!row) return null;
  if (!["FREE", "PAID"].includes(String(row.accessModel)) || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || !Number.isSafeInteger(row.priceKopecks) || Number(row.priceKopecks) < 0 || typeof row.offerRef !== "string"
    || !["CLOSED", "ACCEPTANCE_ONLY", "PUBLIC"].includes(String(row.saleMode)) || ![true, false, 0, 1].includes(row.withdrawn as boolean)) {
    throw new Error("COMMERCE_RESULT_INVALID");
  }
  return { accessModel: row.accessModel as Summary["accessModel"], version: Number(row.version),
    priceKopecks: Number(row.priceKopecks), saleMode: row.saleMode as Summary["saleMode"], withdrawn: Boolean(row.withdrawn), offerRef: row.offerRef };
}

export const courseCommercialWrite: Endpoint = {
  method: "post", path: "/commercial-summary/:courseRef",
  handler: async req => {
    if (!author(req.user)) return reply("AUTHOR_REQUIRED", 401);
    if (!req.url || !req.headers.get("origin") || req.headers.get("origin") !== new URL(req.url).origin) return reply("ORIGIN_NOT_ALLOWED", 403);
    const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
    const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
    if (!origin || !token) return reply("COMMERCE_NOT_CONFIGURED", 503);
    try {
      const courseRef = String(req.routeParams?.courseRef ?? "");
      const input = await req.json?.() as { accessModel?: unknown; priceKopecks?: unknown; expectedVersion?: unknown; commandKey?: unknown };
      if (!input || !["FREE", "PAID"].includes(String(input.accessModel)) || !Number.isSafeInteger(input.priceKopecks)
        || (input.accessModel === "FREE" ? input.priceKopecks !== 0 : Number(input.priceKopecks) <= 0)
        || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0
        || typeof input.commandKey !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.commandKey)) return reply("COURSE_COMMERCIAL_COMMAND_INVALID", 422);
      if (!await hasAuthorCourse(req, courseRef)) return reply("SAVED_COURSE_REQUIRED", 409);
      const response = await fetch(new URL(`/v1/internal/catalog/courses/${encodeURIComponent(courseRef)}/commercial`, origin), {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(3_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ accessModel: input.accessModel, priceKopecks: input.priceKopecks,
          expectedVersion: input.expectedVersion, commandKey: input.commandKey, actor: `payload:${req.user.id}` }),
      });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const allowed = ["CATALOG_VERSION_CONFLICT", "COURSE_COMMAND_KEY_CONFLICT", "WITHDRAWN_PRODUCT_IMMUTABLE", "FREE_ACCESS_HISTORY_REQUIRES_RECONCILIATION"];
        return reply(allowed.includes(String(result.code)) ? String(result.code) : "COURSE_COMMERCIAL_UPDATE_FAILED", 409);
      }
      if (result.version !== Number(input.expectedVersion) + 1 || result.accessModel !== input.accessModel
        || result.priceKopecks !== input.priceKopecks || result.saleMode !== "CLOSED"
        || !["PENDING", "CONFIRMED"].includes(String(result.cacheRefresh))) throw new Error("COMMERCE_RESULT_INVALID");
      return Response.json({ version: result.version, accessModel: result.accessModel, priceKopecks: result.priceKopecks,
        saleMode: result.saleMode, cacheRefresh: result.cacheRefresh }, { headers: noStore });
    } catch { return reply("COMMERCE_WRITE_UNCONFIRMED", 503); }
  },
};
