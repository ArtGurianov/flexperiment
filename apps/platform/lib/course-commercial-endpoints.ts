import type { Endpoint } from "payload";
import { getCampaignCourseSnapshot } from "@/lib/content/editorial";
import { adminOrigin } from "@/lib/origins";

const authorRequired = (user: unknown) => Boolean(user && typeof user === "object" && "collection" in user && user.collection === "users");

const controlRoomCourseUrl = (courseRef: string) => {
  const url = new URL("/courses/", adminOrigin());
  url.searchParams.set("courseRef", courseRef);
  return url.toString();
};

export const courseCommercialEndpoints: Endpoint[] = [{
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
    const response = await fetch(new URL("/v1/internal/campaigns", origin), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({
        courseRef,
        payload: { subject: input.subject.trim(), message: input.message.trim(), lessons: snapshot.lessons },
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
  method: "post",
  path: "/campaigns/:courseRef/:campaignId/dispatch",
  handler: async (req) => {
    if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
    return campaignCommand(req, "dispatch");
  },
}];

async function campaignCommand(req: Parameters<Endpoint["handler"]>[0], action: "confirm" | "dispatch") {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  if (!origin || !token) return Response.json({ code: "COMMERCE_NOT_CONFIGURED" }, { status: 503 });
  const campaignId = String(req.routeParams?.campaignId ?? "");
  const user = req.user as { id?: string | number; email?: string } | null;
  const response = await fetch(new URL(`/v1/internal/campaigns/${encodeURIComponent(campaignId)}/${action}`, origin), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, cache: "no-store",
    body: JSON.stringify(action === "confirm" ? { actor: user?.email ?? String(user?.id ?? "author") } : {}),
  });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
