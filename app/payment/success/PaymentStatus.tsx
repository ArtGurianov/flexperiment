"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { commerceApiUrl } from "@/lib/commerce-api";

export default function PaymentStatus() {
  const params = useSearchParams();
  const statusId = params.get("order");
  const [status, setStatus] = useState<"PROCESSING" | "PAID" | "FAILED">("PROCESSING");
  const [error, setError] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!statusId) return;
    let stopped = false; const started = Date.now(); let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (Date.now() - started >= 10 * 60_000) { if (!stopped) setTimedOut(true); return; }
      try {
        const response = await fetch(commerceApiUrl(`/v1/public/checkout-status/${encodeURIComponent(statusId)}`), { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error("STATUS_FAILED");
        if (stopped) return;
        setStatus(data.status); setError(false);
        if (data.status !== "PROCESSING") return;
        timeout = setTimeout(poll, Date.now() - started < 60_000 ? 6_000 : 12_000);
      } catch {
        if (!stopped) {
          setError(true);
          if (Date.now() - started >= 10 * 60_000) setTimedOut(true);
          else timeout = setTimeout(poll, 12_000);
        }
      }
    };
    timeout = setTimeout(poll, 3_000);
    return () => { stopped = true; if (timeout) clearTimeout(timeout); };
  }, [statusId]);

  const current = statusId ? status : "FAILED";
  const message = current === "PAID" ? "Оплата получена. Инструкции уже отправлены на email." : current === "FAILED" ? "Оплату не удалось подтвердить. Проверьте email или обратитесь в поддержку." : timedOut ? "Проверка заняла больше времени, чем обычно. Проверьте email или обратитесь в поддержку." : "Проверяем оплату…";
  return <main className="mx-auto flex min-h-dvh max-w-lg items-center px-6 text-center"><div className="w-full border-2 border-acid bg-ink p-8 font-mono text-bone"><h1 className="font-display text-3xl text-acid">{current === "PAID" ? "Спасибо" : "FLEXPERIMENT"}</h1><p className="mt-4">{message}</p>{error && <p role="status" className="mt-4 text-sm text-bone/70">Связь прервалась — повторяем проверку.</p>}</div></main>;
}
