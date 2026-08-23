import type { Metadata } from "next";
import Home from "@/app/page";
import { findCityBySlug } from "@/lib/city-catalog";

/**
 * Editorial static entry points are intentionally narrower than the canonical
 * requestable-city catalogue. Their titles still come from that catalogue.
 */
const SEO_CITY_SLUGS = ["kemerovo", "novosibirsk", "novokuznetsk", "tomsk", "irkutsk", "krasnoyarsk"] as const;

export function generateStaticParams() { return SEO_CITY_SLUGS.map((city) => ({ city })); }

export async function generateMetadata({ params }: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const { city } = await params;
  const canonicalCity = findCityBySlug(city);
  return canonicalCity ? { title: `FLEXPERIMENT — ${canonicalCity.title}`, alternates: { canonical: `/${city}` } } : {};
}

/** Static city entry points keep editorial SEO separate from live /v1 commerce data. */
export default function CityPage() { return <Home />; }
