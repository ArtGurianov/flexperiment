export type PurposeSummary = { courseRef: string; accessModel: "FREE" | "PAID";
  offerRef: string | null; paymentPurpose: string | null; version: number; priceKopecks: number | null };

/** Fresh authoritative facts, never the cached storefront summary, for edits/publication. */
export async function freshPurposeSummary(courseRef: string): Promise<PurposeSummary | null> {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  if (!origin || !token) throw new Error("COMMERCE_NOT_CONFIGURED");
  const response = await fetch(new URL("/v1/internal/catalog-summary", origin), {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error("COMMERCE_SUMMARY_UNAVAILABLE");
  const body = await response.json() as { courses: PurposeSummary[] };
  if (!Array.isArray(body.courses)) throw new Error("COMMERCE_SUMMARY_INVALID");
  const matches = body.courses.filter(course => course.courseRef === courseRef);
  if (matches.length > 1) throw new Error("COMMERCE_SUMMARY_INVALID");
  if (matches[0] && (!["FREE", "PAID"].includes(matches[0].accessModel)
    || (matches[0].offerRef !== null && typeof matches[0].offerRef !== "string")
    || !Number.isInteger(matches[0].version)
    || (matches[0].paymentPurpose !== null && typeof matches[0].paymentPurpose !== "string"))) {
    throw new Error("COMMERCE_SUMMARY_INVALID");
  }
  return matches[0] ?? null;
}
