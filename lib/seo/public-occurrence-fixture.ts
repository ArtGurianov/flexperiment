import type { PublicOccurrence } from "@/lib/seo/public-occurrence";
import type { SeoOccurrence } from "@/lib/seo/occurrence-snapshot";

/**
 * The reusable public-occurrence factory the repository did not have.
 *
 * `const base = {...}` plus spread-override is the house idiom — see
 * commerce/test/purchase-status.test.ts:4 — and it is what lets a test name the
 * single field it cares about instead of restating eighteen of them and
 * accidentally varying two.
 *
 * It lives in lib/ rather than in a test directory so that frontend tests, the
 * export conformance tests and the commerce CLI tests can all import the same
 * one. A second, subtly different fixture is how two suites end up disagreeing
 * about what a valid occurrence looks like.
 *
 * The defaults are a deliberately *valid* Novosibirsk occurrence: catalogue
 * city, matching catalogue timezone, a future date, ends after starts, a
 * confirmed venue with both name and address. Every invalid case a test wants
 * is then one override away, and stays obviously the thing being tested.
 */
export const PUBLIC_OCCURRENCE_BASE: PublicOccurrence = {
  id: "11111111-2222-4333-8444-555555555555",
  city: "novosibirsk",
  city_title: "Новосибирск",
  title: "FLEXPERIMENT",
  starts_at: "2030-03-14T11:00:00.000Z",
  ends_at: "2030-03-14T15:00:00.000Z",
  timezone: "Asia/Novosibirsk",
  price_kopecks: 380000,
  availability: 20,
  availability_status: "AVAILABLE",
  sales_status: "OPEN",
  fulfillment_status: "SCHEDULED",
  purchase_status: "AVAILABLE",
  venue: {
    status: "CONFIRMED",
    name: "Студия",
    address: "Красный проспект, 1",
    disclosure_text: null,
    announce_by: null,
  },
};

export const publicOccurrence = (
  overrides: Partial<PublicOccurrence> = {},
): PublicOccurrence => ({
  ...PUBLIC_OCCURRENCE_BASE,
  ...overrides,
  venue: { ...PUBLIC_OCCURRENCE_BASE.venue, ...overrides.venue },
});

/** The same defaults already projected into a snapshot record. */
export const SEO_OCCURRENCE_BASE: SeoOccurrence = {
  id: PUBLIC_OCCURRENCE_BASE.id,
  event_slug: `${PUBLIC_OCCURRENCE_BASE.city}-${PUBLIC_OCCURRENCE_BASE.id}`,
  city: PUBLIC_OCCURRENCE_BASE.city,
  city_title: PUBLIC_OCCURRENCE_BASE.city_title,
  title: PUBLIC_OCCURRENCE_BASE.title,
  starts_at: PUBLIC_OCCURRENCE_BASE.starts_at,
  ends_at: PUBLIC_OCCURRENCE_BASE.ends_at,
  timezone: PUBLIC_OCCURRENCE_BASE.timezone,
  price_kopecks: PUBLIC_OCCURRENCE_BASE.price_kopecks,
  fulfillment_status: PUBLIC_OCCURRENCE_BASE.fulfillment_status,
  venue: { status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1" },
};

export const seoOccurrence = (
  overrides: Partial<SeoOccurrence> = {},
): SeoOccurrence => ({
  ...SEO_OCCURRENCE_BASE,
  ...overrides,
  venue: { ...SEO_OCCURRENCE_BASE.venue, ...overrides.venue },
});
