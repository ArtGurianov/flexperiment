import { cookies, headers } from "next/headers";
import { myOrigin } from "./commerce-proxy";

/** Server-side call from a my page to Commerce on behalf of the current browser (FLEX-121 §6).
 * Same header discipline as the proxy: the surface is my, Origin is my, only the browser's own
 * cookies are forwarded; nothing from the response is logged. */
export async function commerceForBrowser(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {},
  environment: Readonly<Record<string, string | undefined>> = process.env) {
  const origin = myOrigin(environment);
  const upstream = environment.COMMERCE_INTERNAL_ORIGIN?.trim();
  if (!origin || !upstream) return null;
  const jar = (await cookies()).getAll().map(({ name, value }) => `${name}=${value}`).join("; ");
  const incoming = await headers();
  const hops = incoming.get("x-forwarded-for")?.split(",").map((hop) => hop.trim()).filter(Boolean) ?? [];
  const request = new Headers({ "x-forwarded-host": origin.host, "x-forwarded-proto": origin.protocol.replace(":", ""),
    origin: origin.origin, "content-type": "application/json" });
  if (jar) request.set("cookie", jar);
  if (hops.length) request.set("x-forwarded-for", hops.at(-1)!);
  try {
    return await fetch(new URL(path, upstream), { method: init.method ?? "GET", headers: request, cache: "no-store",
      redirect: "manual", signal: AbortSignal.timeout(5000), body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch { return null; }
}
