import type { Metadata } from "next";
import Home from "@/app/page";
import { getCityBySlug, type CitySlug } from "@/lib/city-catalog";

/**
 * Editorial static entry points are intentionally narrower than the canonical
 * requestable-city catalogue. Their titles still come from that catalogue.
 */
const SEO_CITY_SLUGS = ["kemerovo", "novosibirsk", "novokuznetsk", "tomsk", "irkutsk", "krasnoyarsk"] as const satisfies readonly CitySlug[];

const isSeoCitySlug = (value: string): value is (typeof SEO_CITY_SLUGS)[number] =>
  (SEO_CITY_SLUGS as readonly string[]).includes(value);

export function generateStaticParams() { return SEO_CITY_SLUGS.map((city) => ({ city })); }

export async function generateMetadata({ params }: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const { city } = await params;
  if (!isSeoCitySlug(city)) return {};
  const canonicalCity = getCityBySlug(city);
  return { title: `FLEXPERIMENT — ${canonicalCity.title}`, alternates: { canonical: `/${city}` } };
}

/** Static city entry points keep editorial SEO separate from live /v1 commerce data. */
export default function CityPage() { return <Home />; }
