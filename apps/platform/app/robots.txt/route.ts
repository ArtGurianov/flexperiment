import { connection } from "next/server";
import { platformOrigin } from "@/lib/origins";

export async function GET() {
  await connection();
  const origin = platformOrigin();
  const body = process.env.DEPLOY_ENV !== "production"
    ? "User-agent: *\nDisallow: /\n"
    : [
      "User-agent: *", "Allow: /", "Disallow: /admin/", "Disallow: /api/", "Disallow: /account/",
      "Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&gclid /courses",
      `Sitemap: ${origin}/sitemap.xml`, "",
    ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
