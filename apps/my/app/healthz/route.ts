import { connection } from "next/server";

/** Liveness only: no Commerce call, no customer data. Readiness belongs to the release contract (E). */
export async function GET() {
  await connection();
  return Response.json({ ok: true, service: "my" }, { headers: { "Cache-Control": "no-store" } });
}
