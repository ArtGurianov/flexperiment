import { platformOrigin } from "./origins";

export async function invalidatePlatformCache(mode: "swr" | "immediate") {
  const origin = platformOrigin();
  const token = process.env.PLATFORM_REVALIDATE_TOKEN ?? process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  if (!token) {
    if (process.env.DEPLOY_ENV === "production") throw new Error("PLATFORM_REVALIDATION_CONFIGURATION_REQUIRED");
    return;
  }
  const response = await fetch(new URL("/internal/revalidate", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ mode }),
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`PLATFORM_REVALIDATION_HTTP_${response.status}`);
}

export async function notifyIndexNow(paths: readonly string[]) {
  const key = process.env.INDEXNOW_KEY;
  const origin = platformOrigin();
  if (!key || paths.length === 0) return;
  try {
    const host = new URL(origin).host;
    await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host,
        key,
        keyLocation: new URL("/indexnow-key.txt", origin).toString(),
        urlList: paths.map((path) => new URL(path, origin).toString()),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // IndexNow is explicitly best effort and never makes publication fail.
  }
}
