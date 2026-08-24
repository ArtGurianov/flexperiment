"use client";

import { useEffect, useRef, useState } from "react";
import { commerceApiUrl } from "@/lib/commerce-api";
import { formatRubles as rub } from "@/lib/money";

type ConfirmationContext = {
  order_number: string;
  occurrence: { title: string; city: string; starts_at: string; timezone: string };
  amount_remaining_kopecks: number;
  eligibility: string;
  manual_contact?: string;
  expires_at: string;
};


export default function RefundConfirm() {
  const token = useRef<string | null>(null);
  const [context, setContext] = useState<ConfirmationContext | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "submitting" | "confirmed" | "invalid">("loading");

  useEffect(() => {
    const capability = window.location.hash.slice(1);
    history.replaceState(null, "", "/refund/confirm");
    if (!capability) { queueMicrotask(() => setState("invalid")); return; }
    token.current = capability;
    fetch(commerceApiUrl("/v1/public/refunds/confirmation-context"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: capability }), cache: "no-store",
    })
      .then(async (response) => response.ok ? response.json() as Promise<ConfirmationContext> : Promise.reject(new Error("INVALID")))
      .then((value) => { setContext(value); setState("ready"); })
      .catch(() => setState("invalid"));
  }, []);

  const confirm = async () => {
    if (!token.current || !context || context.eligibility !== "ELIGIBLE" || state === "submitting") return;
    setState("submitting");
    try {
      const response = await fetch(commerceApiUrl("/v1/public/refunds/confirm"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.current }), cache: "no-store",
      });
      if (!response.ok) throw new Error("REFUND_CONFIRM_FAILED");
      token.current = null; setState("confirmed");
    } catch { setState("invalid"); }
  };

  const formattedStart = context && new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: context.occurrence.timezone }).format(new Date(context.occurrence.starts_at));
  const text = state === "loading" ? "Проверяем ссылку подтверждения…"
    : state === "confirmed" ? "Отмена участия подтверждена. Возврат передан в обработку."
      : state === "invalid" ? "Ссылка недействительна, истекла или условия автоматической отмены больше не выполняются. Напишите нам на art@flexperiment.ru."
        : context?.eligibility === "ELIGIBLE" ? "Проверьте данные заказа и подтвердите отмену только если хотите отказаться от участия."
          : "Автоматическая отмена сейчас недоступна. Мы поможем через поддержку.";

  return <main className="mx-auto flex min-h-dvh max-w-lg items-center px-6 text-center"><section className="w-full border-2 border-acid bg-ink p-8 font-mono text-bone"><h1 className="font-display text-3xl uppercase text-acid">{state === "confirmed" ? "Готово" : "FLEXPERIMENT"}</h1><p className="mt-5 leading-relaxed">{text}</p>{context && state !== "confirmed" && <div className="mt-6 border border-bone/35 p-4 text-left text-sm leading-relaxed"><p><strong>Заказ:</strong> {context.order_number}</p><p><strong>Мастер-класс:</strong> {context.occurrence.title}</p><p><strong>Город:</strong> {context.occurrence.city}</p><p><strong>Дата:</strong> {formattedStart}</p><p><strong>К возврату:</strong> {rub(context.amount_remaining_kopecks)}</p>{context.eligibility !== "ELIGIBLE" && <p className="mt-3 text-bone/75">Статус: {context.eligibility}. {context.manual_contact ? `Напишите нам: ${context.manual_contact}` : ""}</p>}</div>}{state === "ready" && context?.eligibility === "ELIGIBLE" && <button className="mt-6 w-full border-2 border-acid bg-acid px-4 py-3 font-display uppercase text-ink" onClick={() => void confirm()}>Подтвердить отмену и возврат</button>}{state === "submitting" && <p className="mt-6">Подтверждаем отмену…</p>}{state === "invalid" && <a className="mt-5 inline-block text-acid underline underline-offset-4" href="mailto:art@flexperiment.ru">art@flexperiment.ru</a>}</section></main>;
}
