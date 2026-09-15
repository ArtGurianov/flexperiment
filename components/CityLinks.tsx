import Section, { SectionLabel } from "@/components/Section";
import { publishedCities } from "@/lib/seo/snapshot-source";

/**
 * The home page's links into the city pages.
 *
 * This is the internal-linking spine the site did not have: home → city →
 * event. Without it the event pages would be reachable only from the sitemap,
 * which is a hint rather than a path, and a crawler that never follows a link
 * to a page has little reason to treat it as part of the site.
 *
 * Renders nothing at all when the snapshot has no publishable occurrence, which
 * is today's state. An empty «Города» heading over an empty list would be a
 * worse page than no section, and — unlike the price section, which is an
 * editorial statement about the workshop — this one has no meaning without
 * inventory behind it.
 */
export default function CityLinks() {
  const cities = publishedCities();
  if (cities.length === 0) return null;

  return (
    <Section>
      <SectionLabel className="mb-[5cqw]">Города</SectionLabel>

      <ul className="grid gap-[3cqw]">
        {cities.map((city) => (
          <li key={city.slug}>
            <a
              href={`/cities/${city.slug}`}
              className="flex items-baseline justify-between gap-[3cqw] border-b border-bone/20 pb-[2cqw] text-[clamp(1.05rem,4.5cqw,1.4rem)] text-bone underline-offset-4 transition-colors duration-200 motion-reduce:transition-none hover:text-acid hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid"
            >
              <span>{city.title}</span>
              <span className="font-mono text-[clamp(0.7rem,2.7cqw,0.85rem)] text-bone/60">
                {city.records.length}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}
