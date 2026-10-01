import { headers } from "next/headers";
import { accountLibrary } from "@/lib/content/entitled";

export async function GET() {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  return Response.json({ courses: await accountLibrary(cookieHeader) }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
