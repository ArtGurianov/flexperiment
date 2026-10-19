import type { LabCatalogue } from "../../../lib/lab-v2-contract";

/**
 * Event/Offer JSON-LD for the LAB V2 page (ART-341), built from the same live Commerce response as the
 * visible price, never from a build-time snapshot (the frozen V1 SEO snapshot stays V1's until F9).
 * The page sells nothing, so an offer claims no availability except a sold-out one.
 */
export function labEventsJsonLd(catalogue: LabCatalogue) {
  return catalogue.occurrences.map((event) => {
    const city = catalogue.cities.find((item) => item.cityId === event.cityId)?.title;
    const place = event.venue.status === "CONFIRMED" && event.venue.name ? event.venue.name : city;
    return {
      "@context": "https://schema.org",
      "@type": "Event",
      "@id": `#${event.offerRef}`,
      name: event.title,
      startDate: event.startsAt,
      endDate: event.endsAt,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      ...(place ? { location: { "@type": "Place", name: place,
        ...(event.venue.status === "CONFIRMED" && event.venue.address ? { address: event.venue.address } : {}) } } : {}),
      offers: {
        "@type": "Offer",
        price: (event.amountKopecks / 100).toFixed(2),
        priceCurrency: event.currency,
        ...(event.soldOut ? { availability: "https://schema.org/SoldOut" } : {}),
      },
    };
  });
}
