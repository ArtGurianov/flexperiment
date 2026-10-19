import { connection } from "next/server";
import { platformOrigin } from "@/lib/origins";
import { robotsTxt } from "@/lib/seo";

export async function GET() {
  await connection();
  return new Response(robotsTxt(platformOrigin(), process.env.DEPLOY_ENV), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
