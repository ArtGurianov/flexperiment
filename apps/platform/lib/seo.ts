import type { CourseCommercialSummary } from "./commerce-summary";

type Breadcrumb = { readonly name: string; readonly path: string };

export function breadcrumbJsonLd(origin: string, items: readonly Breadcrumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: new URL(item.path, origin).toString(),
    })),
  };
}

export function courseOfferJsonLd(commercial: CourseCommercialSummary | undefined) {
  if (!commercial) return undefined;
  const availability = commercial.accessModel === "FREE" || commercial.saleMode === "PUBLIC"
    ? "https://schema.org/InStock"
    : commercial.saleMode === "ACCEPTANCE_ONLY"
      ? "https://schema.org/LimitedAvailability"
      : "https://schema.org/SoldOut";
  return {
    "@type": "Offer",
    priceCurrency: "RUB",
    price: commercial.accessModel === "FREE"
      ? "0"
      : commercial.priceKopecks === null
        ? undefined
        : String(commercial.priceKopecks / 100),
    availability,
  };
}

export function lessonIsAccessibleForFree(
  commercial: CourseCommercialSummary | undefined,
  freePreview: boolean,
) {
  return commercial?.accessModel === "FREE" || freePreview;
}
