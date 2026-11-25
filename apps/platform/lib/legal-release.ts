export type LegalDocument = { kind: string; version: string; sha256: string; url: string };
export type LegalRelease = {
  version: string;
  effectiveAt: string;
  manifest: { stage: "A" | "B"; documents: LegalDocument[] };
};

export const currentCoursesLegalPath = "/v1/legal/current?storefront=COURSES";

export const privacyLinkEffectiveAtPath = "/legal/privacy/effective-at";

const moscowDate = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function legalEffectiveDate(effectiveAt?: string | null) {
  if (!effectiveAt) return null;
  const date = new Date(effectiveAt);
  return Number.isFinite(date.getTime()) ? moscowDate.format(date) : null;
}
