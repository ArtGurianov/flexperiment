"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { AnalyticsConsent as AnalyticsConsentState, StoredAnalyticsConsent } from "@/lib/analytics-consent";
import { ANALYTICS_CONSENT_CHANGE_EVENT, applyAnalyticsConsentChoice, notifyAnalyticsConsentChange, persistAnalyticsConsent, readAnalyticsConsent } from "@/components/analytics-consent-client";
import { browserMetrikaEnvironment, createMetrikaManager, metrikaCounterId, syncMetrikaForRoute } from "@/components/metrika";

const PRIVACY_URL = "/legal/privacy-policy";

export default function AnalyticsConsent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const manager = useRef<ReturnType<typeof createMetrikaManager> | null>(null);
  const [consent, setConsent] = useState<AnalyticsConsentState>("UNDECIDED");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const synchronize = () => setConsent(readAnalyticsConsent());
    synchronize();
    window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, synchronize);
    return () => window.removeEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, synchronize);
  }, []);

  useLayoutEffect(() => {
    const counterId = metrikaCounterId();
    manager.current = syncMetrikaForRoute({
      consent,
      counterId,
      manager: manager.current,
      createManager: (id) => createMetrikaManager(id, browserMetrikaEnvironment()),
      pathname,
      search: search ? `?${search}` : "",
    });
  }, [consent, pathname, search]);

  const choose = (next: StoredAnalyticsConsent) => {
    // Cookie persistence happens before React state can allow the manager to
    // load anything. The marker is a first-party functional preference.
    applyAnalyticsConsentChoice(next, {
      persist: persistAnalyticsConsent,
      revoke: () => manager.current?.revoke(),
      notify: notifyAnalyticsConsentChange,
    });
    setConsent(next);
    setSettingsOpen(false);
  };

  return (
    <>
      {consent === "UNDECIDED" && (
        <section
          role="dialog"
          aria-label="Настройки аналитики"
          className="fixed inset-x-3 bottom-3 z-[120] mx-auto max-w-lg border-2 border-acid bg-ink p-4 font-mono text-sm text-bone shadow-[4px_5px_0_var(--color-shadow)]"
        >
          <p>Необязательная аналитика отключена. Разрешите Яндекс Метрике получать данные о посещении сайта и источниках перехода?</p>
          <p className="mt-2 text-bone/70">Подробнее — в <a className="text-acid underline underline-offset-4" href={PRIVACY_URL}>политике конфиденциальности</a>.</p>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" className="border border-bone/60 px-3 py-2 font-display uppercase hover:border-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid" onClick={() => choose("DENIED")}>Только необходимые</button>
            <button type="button" className="border-2 border-acid bg-acid px-3 py-2 font-display uppercase text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid" onClick={() => choose("ALLOWED")}>Разрешить аналитику</button>
          </div>
        </section>
      )}

      {consent !== "UNDECIDED" && (
        <button
          type="button"
          className="fixed right-3 bottom-3 z-[120] border border-bone/60 bg-ink/95 px-3 py-2 font-mono text-xs uppercase text-bone hover:border-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid"
          onClick={() => setSettingsOpen(true)}
        >
          Настройки cookies
        </button>
      )}

      {settingsOpen && (
        <section role="dialog" aria-modal="true" aria-label="Настройки cookies" className="fixed inset-0 z-[121] grid place-items-end bg-ink/75 p-3 sm:place-items-center">
          <div className="w-full max-w-md border-2 border-acid bg-ink p-5 font-mono text-sm text-bone shadow-[5px_6px_0_var(--color-shadow)]">
            <h2 className="font-display text-2xl uppercase text-acid">Настройки cookies</h2>
            <p className="mt-3">Необязательная аналитика отключена, пока вы её не разрешите. Вы можете изменить выбор в любое время.</p>
            <div className="mt-4 grid gap-2">
              <button type="button" aria-pressed={consent === "DENIED"} className="border border-bone/60 px-3 py-2 text-left hover:border-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid" onClick={() => choose("DENIED")}>Только необходимые{consent === "DENIED" ? " — выбрано" : ""}</button>
              <button type="button" aria-pressed={consent === "ALLOWED"} className="border border-bone/60 px-3 py-2 text-left hover:border-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid" onClick={() => choose("ALLOWED")}>Разрешить аналитику{consent === "ALLOWED" ? " — выбрано" : ""}</button>
              <button type="button" className="mt-2 text-left text-acid underline underline-offset-4" onClick={() => setSettingsOpen(false)}>Закрыть</button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
