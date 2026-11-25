import { cache } from "react";
import { proxyCommerce } from "./commerce-proxy";
import { platformOrigin } from "./origins";
import { currentCoursesLegalPath, legalEffectiveDate, type LegalDocument, type LegalRelease } from "./legal-release";

const legalPages: ReadonlyMap<string, { kind: string; title: string }> = new Map([
  ["privacy", { kind: "privacy", title: "Политика конфиденциальности" }],
  ["personal-data", { kind: "personal_data", title: "Согласие на обработку персональных данных" }],
  ["account-terms", { kind: "account_terms", title: "Условия аккаунта" }],
  ["marketing", { kind: "marketing_consent", title: "Согласие на рекламную рассылку Flexperiment" }],
]);

export class CommerceLegalForbidden extends Error {}

export const currentCoursesLegalRelease = cache(async (host: string | null, origin: string | null): Promise<LegalRelease | null> => {
  // Use the same admission and transport as the public API, with an anonymous GET.
  const headers = new Headers();
  if (host !== null) headers.set("host", host);
  if (origin !== null) headers.set("origin", origin);
  const request = new Request(new URL(currentCoursesLegalPath, platformOrigin()), { headers });
  const response = await proxyCommerce(request, ["legal", "current"]);
  if (response.status === 404) {
    const body = await response.json() as { code?: string };
    if (body.code === "LEGAL_RELEASE_NOT_FOUND") return null;
  }
  if (response.status === 403) throw new CommerceLegalForbidden();
  if (!response.ok) throw new Error("COMMERCE_LEGAL_UNAVAILABLE");
  const release = await response.json() as LegalRelease;
  if (!release || !legalEffectiveDate(release.effectiveAt) || !Array.isArray(release.manifest?.documents)) {
    throw new Error("COMMERCE_LEGAL_RELEASE_INVALID");
  }
  return release;
});

export const legalPageHeader = "x-flexperiment-legal-page";

export async function readLegalPage(kind: string, headers: Pick<Headers, "get">) {
  const definition = legalPages.get(kind);
  if (!definition) return null;
  const release = await currentCoursesLegalRelease(headers.get("host"), headers.get("origin"));
  const document = release?.manifest.documents.find(item => item.kind === definition.kind);
  if (!release || !document) return null;
  if (!document.version || !/^[a-f0-9]{64}$/.test(document.sha256) || !document.url.startsWith("https://")) {
    throw new Error("COMMERCE_LEGAL_DOCUMENT_INVALID");
  }
  return { title: definition.title, effectiveAt: release.effectiveAt, document };
}

export type LegalPage = { title: string; effectiveAt: string; document: LegalDocument };
