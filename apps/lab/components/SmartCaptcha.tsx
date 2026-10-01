"use client";

import { useEffect, useRef, useState } from "react";

type WidgetId = string | number;
type SmartCaptchaApi = {
  render(container: HTMLElement, options: { sitekey: string; hl: "ru"; callback: (token: string) => void }): WidgetId;
  reset(widgetId: WidgetId): void;
  destroy(widgetId: WidgetId): void;
  subscribe(widgetId: WidgetId, event: "network-error" | "javascript-error" | "token-expired", callback: () => void): () => void;
};

declare global {
  interface Window { smartCaptcha?: SmartCaptchaApi }
}

let smartCaptchaScript: Promise<SmartCaptchaApi> | null = null;

const loadSmartCaptcha = () => {
  if (window.smartCaptcha) return Promise.resolve(window.smartCaptcha);
  if (smartCaptchaScript) return smartCaptchaScript;
  smartCaptchaScript = new Promise<SmartCaptchaApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://smartcaptcha.cloud.yandex.ru/captcha.js";
    script.async = true;
    script.onload = () => window.smartCaptcha ? resolve(window.smartCaptcha) : reject(new Error("SMARTCAPTCHA_UNAVAILABLE"));
    script.onerror = () => reject(new Error("SMARTCAPTCHA_UNAVAILABLE"));
    document.head.append(script);
  }).catch((error: unknown) => {
    smartCaptchaScript = null;
    throw error;
  });
  return smartCaptchaScript;
};

type Props = {
  onToken: (token: string | null) => void;
  resetKey: number;
};

/**
 * SmartCaptcha is a security dependency, not an analytics tag. It loads only
 * while a protected form is visible and never observes analytics consent.
 */
export default function SmartCaptcha({ onToken, resetKey }: Props) {
  const siteKey = process.env.NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY;
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<WidgetId | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "solved" | "error">(() => siteKey ? "loading" : "error");

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void)[] = [];
    if (!siteKey) return;
    void loadSmartCaptcha().then((api) => {
      if (disposed || !container.current) return;
      const id = api.render(container.current, {
        sitekey: siteKey,
        hl: "ru",
        callback: (token) => {
          if (!token) return;
          setState("solved");
          onToken(token);
        },
      });
      widgetId.current = id;
      const invalidate = () => {
        if (disposed) return;
        setState("ready");
        onToken(null);
      };
      unsubscribe = [
        api.subscribe(id, "token-expired", invalidate),
        api.subscribe(id, "network-error", () => { setState("error"); onToken(null); }),
        api.subscribe(id, "javascript-error", () => { setState("error"); onToken(null); }),
      ];
      setState("ready");
    }).catch(() => {
      if (!disposed) { setState("error"); onToken(null); }
    });
    return () => {
      disposed = true;
      unsubscribe.forEach((remove) => remove());
      if (widgetId.current !== null && window.smartCaptcha) window.smartCaptcha.destroy(widgetId.current);
      widgetId.current = null;
    };
  }, [onToken, siteKey]);

  useEffect(() => {
    if (widgetId.current === null || !window.smartCaptcha) return;
    window.smartCaptcha.reset(widgetId.current);
    setState("ready");
    onToken(null);
  }, [onToken, resetKey]);

  return <div>
    <div ref={container} className="min-h-[100px]" aria-label="Проверка безопасности" />
    {state === "loading" && <p className="text-xs text-bone/70" role="status">Загружаем проверку…</p>}
    {state === "error" && <p className="text-xs text-bone/70" role="status">Не удалось загрузить проверку. Попробуйте обновить страницу.</p>}
  </div>;
}
