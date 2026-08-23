/**
 * Cities where Flexperiment can plan a workshop. This is deliberately separate
 * from the live catalogue: an occurrence is only shown after Commerce has
 * published it, while this list is the bounded set a visitor may request.
 *
 * Keep this data-only so it can be used by both the static site and Commerce.
 */
export const CITY_CATALOGUE = [
  { slug: "kemerovo", title: "Кемерово" },
  { slug: "novosibirsk", title: "Новосибирск" },
  { slug: "novokuznetsk", title: "Новокузнецк" },
  { slug: "tomsk", title: "Томск" },
  { slug: "irkutsk", title: "Иркутск" },
  { slug: "krasnoyarsk", title: "Красноярск" },
] as const;

export const CITY_SLUGS = CITY_CATALOGUE.map(({ slug }) => slug) as [
  (typeof CITY_CATALOGUE)[number]["slug"],
  ...(typeof CITY_CATALOGUE)[number]["slug"][],
];

export type CitySlug = (typeof CITY_CATALOGUE)[number]["slug"];
