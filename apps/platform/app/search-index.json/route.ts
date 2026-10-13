import { NextResponse } from "next/server";
import { connection } from "next/server";
import { publicSearchDocuments } from "@/lib/content/public";

export async function GET() {
  await connection();
  const documents = (await publicSearchDocuments()).map(({ type, ref, title, summary, url }) => ({
    type, ref, title, summary, url,
  }));
  return NextResponse.json(documents, {
    headers: { "Cache-Control": "no-store" },
  });
}
