import type { Endpoint } from "payload";
import { getCampaignCourseSnapshot } from "@/lib/content/editorial";
import { adminOrigin } from "@/lib/origins";
import { freshPurposeSummary } from "@/lib/offer-payment-purpose";
import { validPaymentPurpose } from "../../../commerce-v2/src/payment-purpose";

const authorRequired = (user: unknown) => Boolean(user && typeof user === "object" && "collection" in user && user.collection === "users");

const controlRoomCourseUrl = (courseRef: string) => {
  const url = new URL("/courses/", adminOrigin());
  url.searchParams.set("courseRef", courseRef);
  return url.toString();
};

export const courseCommercialEndpoints: Endpoint[] = [{
  method: "get",
  path: "/payment-purpose/:courseRef",
  handler: async req => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    try {
      const summary = await freshPurposeSummary(String(req.routeParams?.courseRef ?? ""));
      if (!summary?.offerRef) return Response.json({ code: "OFFER_NOT_CONFIGURED" }, { status: 409 });
      return Response.json({ paymentPurpose: summary.paymentPurpose, version: summary.version, offerRef: summary.offerRef },
        { headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ code: "COMMERCE_UNAVAILABLE" }, { status: 503 }); }
  },
}, {
  method: "post",
  path: "/payment-purpose/:courseRef",
  handler: async req => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    // Cookie-authenticated mutation must originate on this CMS, including requests outside its UI.
    const requestOrigin = req.headers.get("origin");
    if (!req.url || !requestOrigin || requestOrigin !== new URL(req.url).origin) return Response.json({ code: "ORIGIN_NOT_ALLOWED" }, { status: 403 });
    const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
    const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
    if (!origin || !token) return Response.json({ code: "COMMERCE_NOT_CONFIGURED" }, { status: 503 });
    try {
      const input = await req.json?.() as { paymentPurpose?: unknown; expectedVersion?: unknown } | undefined;
      if (!validPaymentPurpose(input?.paymentPurpose) || !Number.isInteger(input?.expectedVersion)) {
        return Response.json({ code: "PAYMENT_PURPOSE_REQUIRED" }, { status: 422 });
      }
      const courseRef = String(req.routeParams?.courseRef ?? "");
      const user = req.user as { id: string | number };
      const response = await fetch(new URL(`/v1/internal/catalog/payment-purpose/${encodeURIComponent(courseRef)}`, origin), {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        cache: "no-store", signal: AbortSignal.timeout(3_000),
        body: JSON.stringify({ paymentPurpose: input!.paymentPurpose, expectedVersion: input!.expectedVersion, actor: `payload:${user.id}` }),
      });
      // Do not echo a raw internal response or provider/transport exception to the browser.
      const body = await response.json() as { paymentPurpose?: string; version?: number; error?: { code?: string } };
      if (!response.ok) return Response.json({ code: body.error?.code === "CATALOG_VERSION_CONFLICT" ? "CATALOG_VERSION_CONFLICT" : "PAYMENT_PURPOSE_UPDATE_FAILED" }, { status: 409 });
      if (body.paymentPurpose !== input!.paymentPurpose || !Number.isInteger(body.version)
        || body.version !== Number(input!.expectedVersion) + 1) throw new Error("COMMERCE_RESULT_INVALID");
      return Response.json({ paymentPurpose: body.paymentPurpose, version: body.version }, { headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ code: "COMMERCE_UNAVAILABLE" }, { status: 503 }); }
  },
}, {
  method: "get",
  path: "/commercial-summary/:courseRef",
  handler: async (req) => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
    const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
    if (!origin || !token) return Response.json({ code: "COMMERCE_NOT_CONFIGURED" }, { status: 503 });
    const response = await fetch(new URL("/v1/internal/catalog-summary", origin), {
      headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return Response.json({ code: `COMMERCE_HTTP_${response.status}` }, { status: 503 });
    const body = await response.json() as { courses: Array<{ courseRef: string }> };
    const summary = body.courses.filter((course) => course.courseRef === req.routeParams?.courseRef)[0];
    const courseRef = String(req.routeParams?.courseRef ?? "");
    return summary
      ? Response.json({ ...summary, controlRoomUrl: controlRoomCourseUrl(courseRef) })
      : Response.json({ state: "UNCONFIGURED", controlRoomUrl: controlRoomCourseUrl(courseRef) });
  },
}, {
  method: "post",
  path: "/campaigns/:courseRef",
  handler: async (req) => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
    const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
    if (!origin || !token) return Response.json({ code: "COMMERCE_NOT_CONFIGURED" }, { status: 503 });
    const courseRef = String(req.routeParams?.courseRef ?? "");
    const snapshot = await getCampaignCourseSnapshot(req.payload, courseRef, req);
    if (!snapshot) return Response.json({ code: "COURSE_NOT_PUBLISHED" }, { status: 409 });
    const input = await req.json?.() as { subject?: string; message?: string } | undefined;
    if (!input?.subject?.trim() || !input.message?.trim()) return Response.json({ code: "CAMPAIGN_CONTENT_REQUIRED" }, { status: 422 });
    const idempotencyKey = req.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) return Response.json({ code: "CAMPAIGN_IDEMPOTENCY_KEY_REQUIRED" }, { status: 422 });
    const response = await fetch(new URL("/v1/internal/campaigns", origin), {
      method: "POST", headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      }, cache: "no-store",
      body: JSON.stringify({
        courseRef,
        payload: { subject: input.subject.trim(), message: input.message.trim(), course: snapshot.course, lessons: snapshot.lessons },
      }),
    });
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  },
}, {
  method: "post",
  path: "/campaigns/:courseRef/:campaignId/confirm",
  handler: async (req) => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    return campaignCommand(req, "confirm");
  },
}, {
  method: "get",
  path: "/campaigns/:courseRef/:campaignId/status",
  handler: async (req) => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    return campaignCommand(req, "status");
  },
}, {
  method: "post",
  path: "/campaigns/:courseRef/:campaignId/retry",
  handler: async (req) => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    return campaignCommand(req, "retry");
  },
}];

async function campaignCommand(req: Parameters<Endpoint["handler"]>[0], action: "confirm" | "status" | "retry") {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  if (!origin || !token) return Response.json({ code: "COMMERCE_NOT_CONFIGURED" }, { status: 503 });
  const campaignId = String(req.routeParams?.campaignId ?? "");
  const user = req.user as { id?: string | number; email?: string } | null;
  const response = await fetch(new URL(`/v1/internal/campaigns/${encodeURIComponent(campaignId)}/${action}`, origin), {
    method: action === "status" ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    cache: "no-store",
    body: action === "status" ? undefined : JSON.stringify(action === "confirm" ? { actor: user?.email ?? String(user?.id ?? "author") } : {}),
  });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
