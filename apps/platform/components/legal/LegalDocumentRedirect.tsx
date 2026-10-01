"use client";

import { useEffect, useState } from "react";

type LegalDocument = { kind: string; version: string; sha256: string; url: string };

export default function LegalDocumentRedirect({ kind, title }: { kind: string; title: string }) {
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("Открываем действующую редакцию…");

  useEffect(() => {
    let active = true;
    void fetch("/v1/legal/current?storefront=COURSES", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const release = await response.json() as { manifest?: { documents?: LegalDocument[] } };
        const byKind = new Map(release.manifest?.documents?.map((item) => [item.kind, item]));
        const current = byKind.get(kind);
        if (!response.ok || !current || !current.url.startsWith("https://")) throw new Error("LEGAL_DOCUMENT_NOT_FOUND");
        const target = new URL(current.url);
        if (target.origin === window.location.origin && target.pathname === window.location.pathname) {
          throw new Error("LEGAL_DOCUMENT_REDIRECT_LOOP");
        }
        if (!active) return;
        setDocumentUrl(current.url);
        window.location.replace(current.url);
      })
      .catch(() => { if (active) setMessage("Действующая редакция документа временно недоступна."); });
    return () => { active = false; };
  }, [kind]);

  return <main className="accountPage"><section className="accountPanel"><p className="eyebrow">Правовая информация</p><h1>{title}</h1><p role="status">{message}</p>{documentUrl && <p><a href={documentUrl}>Открыть документ →</a></p>}</section></main>;
}
