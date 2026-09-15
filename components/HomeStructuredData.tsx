import { serializeJsonLd } from "@/lib/seo/json-ld";
import { SITE_ORIGIN } from "@/lib/seo/site";

/**
 * Organization and Person markup for the home page.
 *
 * Every value here is a fact the repository already states in
 * components/Footer.tsx (the ИП name, ИНН, ОГРНИП, phone and email) or in
 * app/page.tsx (the site name and description). Nothing is invented: there is
 * no `sameAs`, no `address`, no `award`, no `foundingDate` and no `logo`,
 * because the repo does not carry verified values for any of them and a
 * plausible-looking guess in structured data is a claim, not a placeholder.
 *
 * No Event or Offer markup here either. Those are commercial facts owned by
 * Commerce, and the home page's price is editorial (see components/Price.tsx) —
 * emitting it as a machine-readable Offer would assert a bookable price for an
 * occurrence that does not exist. Event markup belongs on an event page, from
 * the validated snapshot.
 *
 * FAQPage is deliberately absent too. Google restricted FAQ rich results to
 * government and health sites in August 2023, so the markup buys nothing; the
 * four-question FAQ stays because it is useful content, not because it is
 * eligible for a rich result.
 */
const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
const PERSON_ID = `${SITE_ORIGIN}/#art-guryanov`;

const GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": ORGANIZATION_ID,
      name: "FLEXPERIMENT",
      url: SITE_ORIGIN,
      // The legal entity behind the brand, exactly as the footer states it.
      legalName: "ИП Гурьянов Арт Артурович",
      taxID: "420539506224",
      identifier: [
        { "@type": "PropertyValue", propertyID: "ИНН", value: "420539506224" },
        { "@type": "PropertyValue", propertyID: "ОГРНИП", value: "324420500074591" },
      ],
      telephone: "+7 926 728-04-20",
      email: "art@flexperiment.ru",
      founder: { "@id": PERSON_ID },
    },
    {
      "@type": "Person",
      "@id": PERSON_ID,
      name: "Арт Гурьянов",
      // "преподаватель" is what the page itself calls him — see TeacherSection.
      jobTitle: "Преподаватель",
      worksFor: { "@id": ORGANIZATION_ID },
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      url: SITE_ORIGIN,
      name: "FLEXPERIMENT",
      inLanguage: "ru-RU",
      publisher: { "@id": ORGANIZATION_ID },
    },
  ],
};

/**
 * Server-rendered, so it is in the static HTML a crawler receives rather than
 * appearing after hydration.
 *
 * Every value in `GRAPH` is a literal in this file, so nothing here can carry a
 * `</script>` sequence today. It still goes through serializeJsonLd: a
 * serializer that is only safe at some call sites is one refactor away from
 * being unsafe at all of them.
 */
export default function HomeStructuredData() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(GRAPH) }}
    />
  );
}
