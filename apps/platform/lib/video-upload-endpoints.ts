import type { Endpoint } from "payload";

const commerce = async (path: string, init: RequestInit = {}) => {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  if (!origin || !token) return Response.json({ code: "COMMERCE_NOT_CONFIGURED" }, { status: 503 });
  return fetch(new URL(path, origin), {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
};

const authorRequired = (user: unknown) => Boolean(user && typeof user === "object" && "collection" in user && user.collection === "users");

export const videoUploadEndpoints: Endpoint[] = [
  {
    method: "post",
    path: "/video-upload",
    handler: async (req) => {
      if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
      const body = await req.json?.() as { lessonRef?: unknown; title?: unknown; filename?: unknown; filesize?: unknown };
      if (typeof body?.lessonRef !== "string" || typeof body.title !== "string"
        || typeof body.filename !== "string" || !body.filename
        || typeof body.filesize !== "number" || !Number.isSafeInteger(body.filesize) || body.filesize <= 0) {
        return Response.json({ code: "VIDEO_UPLOAD_INPUT_INVALID" }, { status: 422 });
      }
      // Kinescope's Tus init needs the selected file's name and size; forward only the contract fields.
      return commerce("/v1/internal/video-uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lessonRef: body.lessonRef, title: body.title, filename: body.filename, filesize: body.filesize }),
      });
    },
  },
  {
    method: "get",
    path: "/video-upload/:id",
    handler: async (req) => {
      if (!authorRequired(req.user)) return Response.json({ code: "AUTHOR_REQUIRED" }, { status: 401 });
      const id = req.routeParams?.id;
      if (typeof id !== "string") return Response.json({ code: "VIDEO_UPLOAD_ID_REQUIRED" }, { status: 422 });
      return commerce(`/v1/internal/video-uploads/${encodeURIComponent(id)}`);
    },
  },
];
