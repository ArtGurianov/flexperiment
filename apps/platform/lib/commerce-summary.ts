import { unstable_cache } from "next/cache";

export type CourseCommercialSummary = {
  readonly courseRef: string;
  readonly offerRef: string | null;
  readonly accessModel: "FREE" | "PAID";
  readonly withdrawn: boolean;
  readonly saleMode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  readonly priceKopecks: number | null;
};

const configuration = () => ({
  origin: process.env.COMMERCE_INTERNAL_ORIGIN,
  token: process.env.PLATFORM_COMMERCE_SERVICE_TOKEN,
});

const loadCommercialSummaries = async (): Promise<Array<[string, CourseCommercialSummary]>> => {
  const { origin, token } = configuration();
  if (!origin || !token) {
    if (process.env.DEPLOY_ENV === "production") throw new Error("COMMERCE_SUMMARY_CONFIGURATION_REQUIRED");
    return [];
  }
  const response = await fetch(new URL("/v1/internal/catalog-summary", origin), {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`COMMERCE_SUMMARY_HTTP_${response.status}`);
  const body = await response.json() as { courses: CourseCommercialSummary[] };
  return body.courses.map((course) => [course.courseRef, course]);
};

const cachedCommercialSummaries = unstable_cache(loadCommercialSummaries, ["commercial-summaries"], {
  revalidate: 300,
  tags: ["commerce", "catalog", "search"],
});

export async function getCommercialSummaries(): Promise<Map<string, CourseCommercialSummary>> {
  return new Map(await cachedCommercialSummaries());
}
