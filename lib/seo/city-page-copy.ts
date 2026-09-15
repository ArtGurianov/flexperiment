/**
 * The title and description a city page presents to a crawler.
 *
 * A pure function, and a separate module, for one reason: the choice it makes
 * depends on whether the city has any upcoming date, and that branch needs to
 * be testable without writing a snapshot to disk and running a build. The page
 * itself only decides which city it is looking at.
 *
 * The two branches exist because a city page outlives its dates. A city keeps
 * its page after its last occurrence is cancelled or passes — its event pages
 * link back to it, and those URLs are permanent — but at that point the page is
 * an archive, and describing it as «Ближайшие мастер-классы … даты, площадка и
 * стоимость участия» is a straightforward falsehood. The page body already says
 * so («Ближайшие даты в этом городе пока не объявлены»); the metadata was still
 * promising dates that do not exist, which is the version a search result
 * shows.
 *
 * This is the same distinction that already keeps an archive-only city off the
 * home page and out of the sitemap. Its URL stays alive; it just stops claiming
 * to be somewhere the tour is going.
 */
export type CityPageCopy = { readonly title: string; readonly description: string };

export function cityPageCopy({
  cityTitle,
  hasUpcoming,
}: {
  cityTitle: string;
  hasUpcoming: boolean;
}): CityPageCopy {
  if (!hasUpcoming) {
    return {
      title: `FLEXPERIMENT в городе ${cityTitle} — прошедшие мастер-классы`,
      description:
        `Ближайшие мастер-классы FLEXPERIMENT в городе ${cityTitle} пока не объявлены. ` +
        "На странице — прошедшие и отменённые даты по флексингу и experimental dance.",
    };
  }

  return {
    title: `Мастер-классы по флексингу в городе ${cityTitle} | FLEXPERIMENT`,
    description:
      `Ближайшие мастер-классы FLEXPERIMENT по флексингу и experimental dance в городе ${cityTitle}: ` +
      "даты, площадка и стоимость участия. Преподаватель — Арт Гурьянов.",
  };
}
