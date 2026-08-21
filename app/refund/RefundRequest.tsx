"use client";

import { FormEvent, useState } from "react";
import { commerceApiUrl } from "@/lib/commerce-api";

export default function RefundRequest() {
  const [orderNumber, setOrderNumber] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState("sending");
    try {
      const response = await fetch(commerceApiUrl("/v1/public/refunds/request"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_number: orderNumber }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("REQUEST_FAILED");
      setState("sent");
    } catch {
      setState("error");
    }
  };

  return <main className="mx-auto flex min-h-dvh max-w-lg items-center px-6 py-12"><section className="w-full border-2 border-acid bg-ink p-7 font-mono text-bone sm:p-9"><p className="text-xs uppercase tracking-[0.16em] text-acid">FLEXPERIMENT / ORDER</p><h1 className="mt-3 font-display text-3xl uppercase text-acid">Отмена и возврат</h1><p className="mt-5 leading-relaxed">До одного часа до начала мастер-класса можно подтвердить отмену участия и полный возврат через письмо. После этого срока напишите нам на <a className="text-acid underline underline-offset-4" href="mailto:art@flexperiment.ru">art@flexperiment.ru</a>: это не ограничивает ваши права по закону.</p>{state !== "sent" ? <form className="mt-7 space-y-4" onSubmit={submit}><label className="block text-sm">Номер заказа<input className="mt-2 w-full border border-bone/35 bg-transparent px-3 py-3 font-mono uppercase outline-none focus:border-acid" autoComplete="off" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value.toUpperCase())} placeholder="FX-0123ABCD…" required /></label><button className="w-full border-2 border-acid bg-acid px-4 py-3 font-display uppercase text-ink disabled:opacity-60" disabled={state === "sending"}>{state === "sending" ? "Отправляем…" : "Получить ссылку подтверждения"}</button>{state === "error" && <p role="status" className="text-sm text-bone/75">Не удалось отправить запрос. Повторите попытку позже или напишите нам.</p>}</form> : <p role="status" className="mt-7 border border-acid/70 p-4 leading-relaxed">Если автоматическая отмена доступна для указанного заказа, мы отправили ссылку подтверждения на email, использованный при оплате. Проверьте входящие и папку «Спам».</p>}</section></main>;
}
