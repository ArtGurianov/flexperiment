import { headers } from "next/headers";
import { notFound } from "next/navigation";
import LegalEffectiveDate from "@/components/legal/LegalEffectiveDate";
import { legalPageHeader, type LegalPage } from "@/lib/legal-release-server";

export const instant = false;

export default async function LegalDocumentPage() {
  // Proxy resolves the document before Next can commit the streamed status.
  const resolved = (await headers()).get(legalPageHeader);
  if (!resolved) notFound();
  const { title, effectiveAt, document } = JSON.parse(decodeURIComponent(resolved)) as LegalPage;

  return <main className="accountPage">
    <section className="accountPanel legalDocument">
      <h1>{title}</h1>
      <dl className="legalDocumentFacts">
        <dt>Версия</dt><dd>{document.version}</dd>
        <dt>Действует с</dt><dd><LegalEffectiveDate effectiveAt={effectiveAt} /></dd>
        <dt>SHA-256</dt><dd><code>{document.sha256}</code></dd>
      </dl>
      <a className="primary" href={document.url}>Открыть исходный документ <span aria-hidden>↗</span></a>
    </section>
  </main>;
}
