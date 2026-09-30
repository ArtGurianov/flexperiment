const allowedRoots = new Set(["auth", "me", "lessons", "checkout", "email", "legal"]);

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin) return Response.json({ code: "COMMERCE_NOT_CONFIGURED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const path = (await params).path;
  if (!path[0] || !allowedRoots.has(path[0])) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  const source = new URL(request.url);
  const target = new URL(`/v1/${path.map(encodeURIComponent).join("/")}${source.search}`, origin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-forwarded-host", source.host);
  headers.set("x-forwarded-proto", source.protocol.replace(":", ""));
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    cache: "no-store",
    // Required by Node's streaming request implementation.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
