/**
 * The in-page sections, shared by the navbar and the footer.
 *
 * The hrefs are root-relative rather than bare fragments because the footer
 * also renders on the legal pages, where `#teacher` would resolve against
 * `/legal/...` and go nowhere. From the home page `/#teacher` is still a
 * same-document fragment navigation, so the navbar behaves exactly as before.
 */
export const SITE_LINKS = [
  { label: "Кто", href: "/#teacher" },
  { label: "Программа", href: "/#program" },
  { label: "Вопросы", href: "/#faq" },
] as const;

/** The label every booking CTA outside the page body carries. */
export const BOOKING_LABEL = "Города × Даты";
