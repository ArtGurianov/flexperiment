import { cache } from "react";
import { currentCoursesLegalPath, legalEffectiveDate, type LegalDocument, type LegalRelease } from "./legal-release";

const legalPages: ReadonlyMap<string, { kind: string; title: string }> = new Map([
  ["privacy", { kind: "privacy", title: "Политика конфиденциальности" }],
  ["personal-data", { kind: "personal_data", title: "Согласие на обработку персональных данных" }],
  ["account-terms", { kind: "account_terms", title: "Условия аккаунта" }],
  ["marketing", { kind: "marketing_consent", title: "Согласие на рекламную рассылку Flexperiment" }],
]);

export const currentCoursesLegalRelease = cache(async (): Promise<LegalRelease | null> => {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin) throw new Error("COMMERCE_LEGAL_NOT_CONFIGURED");
  const response = await fetch(new URL(currentCoursesLegalPath, origin), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3_000),
  });
  if (response.status === 404) {
    const body = await response.json() as { code?: string };
    if (body.code === "LEGAL_RELEASE_NOT_FOUND") return null;
  }
  if (!response.ok) throw new Error("COMMERCE_LEGAL_UNAVAILABLE");
  return await response.json() as LegalRelease;
});

export const legalPageHeader = "x-flexperiment-legal-page";

export async function readLegalPage(kind: string) {
  const definition = legalPages.get(kind);
  if (!definition) return null;
  const release = await currentCoursesLegalRelease();
  const document = release?.manifest.documents.find(item => item.kind === definition.kind);
  if (!release || !document) return null;
  if (!legalEffectiveDate(release.effectiveAt) || !document.url.startsWith("https://")) {
    throw new Error("COMMERCE_LEGAL_DOCUMENT_INVALID");
  }
  return { title: definition.title, effectiveAt: release.effectiveAt, document };
}

export type LegalPage = { title: string; effectiveAt: string; document: LegalDocument };
