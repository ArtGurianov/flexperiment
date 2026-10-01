import { readBuildIdentity } from "@/lib/build-identity";
import { connection } from "next/server";

export async function GET() {
  await connection();
  return Response.json(readBuildIdentity("platform"), {
    headers: { "Cache-Control": "no-store" },
  });
}
