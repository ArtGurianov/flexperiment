"use client";

import Link from "next/link";
import { LegalLinkDate } from "@/components/legal/LegalEffectiveDate";
import { currentCoursesLegalPath, type LegalRelease } from "@/lib/legal-release";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  analyticsConsentFromCookie,
  analyticsConsentSetCookie,
  safeAnalyticsLocation,
  safeAnalyticsReferrer,
  type AnalyticsConsent,
  type StoredAnalyticsConsent,
} from "@/lib/analytics-consent";

type MetrikaCommand = [number, "init" | "hit" | "destruct", ...unknown[]];
type MetrikaWindow = Window & { ym?: ((...command: MetrikaCommand) => void) & { a?: MetrikaCommand[]; l?: number } };
const SETTINGS_EVENT = "flexperiment:analytics-settings-open";
const SCRIPT_ID = "flexperiment-metrika";

const counterId = () => {
  const value = Number(process.env.NEXT_PUBLIC_YANDEX_METRIKA_ID);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

function installQueue(browser: MetrikaWindow) {
  if (browser.ym) return browser.ym;
  const queue = ((...command: MetrikaCommand) => { queue.a?.push(command); }) as NonNullable<MetrikaWindow["ym"]>;
  queue.a = [];
  queue.l = Date.now();
  browser.ym = queue;
  return queue;
}

function clearMetrika(id: number | null, initialized: boolean) {
  const browser = window as MetrikaWindow;
  if (id && initialized) browser.ym?.(id, "destruct");
  document.getElementById(SCRIPT_ID)?.remove();
  for (const part of document.cookie.split(";")) {
    const name = part.trim().split("=", 1)[0];
    if (name.startsWith("_ym_")) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
  }
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("_ym")) localStorage.removeItem(key);
  }
}

export function AnalyticsSettingsButton() {
  return <button className="analyticsSettings" type="button" onClick={() => window.dispatchEvent(new Event(SETTINGS_EVENT))}>Настройки cookies</button>;
}

function PrivacyPolicyLink() {
  const [effectiveAt, setEffectiveAt] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(currentCoursesLegalPath, {
      cache: "no-store", credentials: "omit", signal: controller.signal,
    }).then(async response => {
      const release = response.ok ? await response.json() as LegalRelease : null;
      if (!controller.signal.aborted) setEffectiveAt(release?.effectiveAt);
    }).catch(() => { /* The privacy link remains available while Commerce is unavailable. */ });
    return () => controller.abort();
  }, []);
  return <><Link href="/legal/privacy" prefetch={false}>Подробнее в политике конфиденциальности</Link><LegalLinkDate effectiveAt={effectiveAt} /></>;
}

export default function AnalyticsConsentManager() {
  const pathname = usePathname();
  const [consent, setConsent] = useState<AnalyticsConsent>(() => typeof document === "undefined" ? "UNDECIDED" : analyticsConsentFromCookie(document.cookie));
  const [prompt, setPrompt] = useState(false);
  const [settings, setSettings] = useState(false);
  const initialized = useRef(false);
  // The previous hit's page becomes the next hit's referrer; the first hit uses the sanitized document.referrer.
  const previousPage = useRef<string | null>(null);

  useEffect(() => {
    const open = () => setSettings(true);
    window.addEventListener(SETTINGS_EVENT, open);
    return () => window.removeEventListener(SETTINGS_EVENT, open);
  }, []);

  useEffect(() => {
    if (consent !== "UNDECIDED" || pathname.startsWith("/admin") || pathname.startsWith("/account")) return;
    const show = () => setPrompt(true);
    const onScroll = () => { if (window.scrollY > 60) show(); };
    const timeout = window.setTimeout(show, 4_000);
    window.addEventListener("scroll", onScroll, { passive: true, once: true });
    return () => { window.clearTimeout(timeout); window.removeEventListener("scroll", onScroll); };
  }, [consent, pathname]);

  useEffect(() => {
    const id = counterId();
    if (consent !== "ALLOWED" || !id) {
      if (consent === "DENIED") { clearMetrika(id, initialized.current); initialized.current = false; }
      return;
    }
    const browser = window as MetrikaWindow;
    const ym = installQueue(browser);
    if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement("script");
      script.id = SCRIPT_ID; script.async = true; script.src = "https://mc.yandex.ru/metrika/tag.js";
      document.head.append(script);
    }
    if (!initialized.current) {
      // Minimized per privacy §4: no click map, no link/download tracking, no session replay (webvisor).
      // Re-enabling clickmap/trackLinks is an owner decision (D-12) that needs a privacy disclosure first.
      ym(id, "init", { clickmap: false, trackLinks: false, accurateTrackBounce: true, defer: true });
      initialized.current = true;
    }
    const location = safeAnalyticsLocation(pathname, window.location.search);
    if (location) {
      const referer = previousPage.current ?? safeAnalyticsReferrer(document.referrer);
      ym(id, "hit", location, referer ? { title: document.title, referer } : { title: document.title });
      previousPage.current = `${window.location.origin}${pathname}`;
    }
  }, [consent, pathname]);

  const choose = (choice: StoredAnalyticsConsent) => {
    document.cookie = analyticsConsentSetCookie(choice);
    if (choice === "DENIED") clearMetrika(counterId(), initialized.current);
    setConsent(choice); setPrompt(false); setSettings(false);
  };

  const visible = prompt || settings;
  return visible ? <section className="consentDialog" role="dialog" aria-modal={settings || undefined} aria-label="Настройки аналитики">
    <strong>{settings ? "Настройки cookies" : "Необязательная аналитика отключена"}</strong>
    <p>Яндекс Метрика не загружается без вашего разрешения. Выбор можно изменить в любое время. <PrivacyPolicyLink key={settings ? "settings" : "prompt"} />.</p>
    <div><button type="button" aria-pressed={consent === "DENIED"} onClick={() => choose("DENIED")}>Только необходимые</button><button type="button" aria-pressed={consent === "ALLOWED"} onClick={() => choose("ALLOWED")}>Разрешить аналитику</button>{settings && <button type="button" onClick={() => setSettings(false)}>Закрыть</button>}</div>
  </section> : null;
}
