import type { Metadata } from "next";
import Home from "@/app/page";

const cities = {
  kemerovo: "Кемерово",
  novosibirsk: "Новосибирск",
  novokuznetsk: "Новокузнецк",
  tomsk: "Томск",
  irkutsk: "Иркутск",
  krasnoyarsk: "Красноярск",
} as const;

export function generateStaticParams() { return Object.keys(cities).map((city) => ({ city })); }

export async function generateMetadata({ params }: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const { city } = await params;
  const title = cities[city as keyof typeof cities];
  return title ? { title: `FLEXPERIMENT — ${title}`, alternates: { canonical: `/${city}` } } : {};
}

/** Static city entry points keep editorial SEO separate from live /v1 commerce data. */
export default function CityPage() { return <Home />; }
