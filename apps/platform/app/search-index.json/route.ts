import { NextResponse } from "next/server";
import { publicSearchDocuments } from "@/lib/content/public";
import { getCommercialSummaries } from "@/lib/commerce-summary";
import { buildPublicSearchIndex } from "@/lib/public-search";

export async function GET() {
  const [allDocuments, commercial] = await Promise.all([publicSearchDocuments(), getCommercialSummaries()]);
  const documents = buildPublicSearchIndex(allDocuments, commercial);
  return NextResponse.json(documents, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
