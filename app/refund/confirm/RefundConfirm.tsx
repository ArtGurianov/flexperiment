"use client";

import { useEffect, useState } from "react";
import { commerceApiUrl } from "@/lib/commerce-api";

export default function RefundConfirm() {
  const [state, setState] = useState<"confirming" | "confirmed" | "invalid">("confirming");
  useEffect(() => {
    const capability = window.location.hash.slice(1);
    history.replaceState(null, "", "/refund/confirm");
    if (!capability) { queueMicrotask(() => setState("invalid")); return; }
    fetch(commerceApiUrl("/v1/public/refunds/confirm"), { method: "POST", headers: { Authorization: `Bearer ${capability}` }, cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(() => setState("confirmed"))
      .catch(() => setState("invalid"));
  }, []);

  const text = state === "confirming" ? "Подтверждаем отмену участия…" : state === "confirmed" ? "Отмена участия подтверждена. Мы оформили полный возврат; срок зачисления зависит от вашего банка." : "Ссылка недействительна, истекла или условия автоматической отмены больше не выполняются. Напишите нам на art@flexperiment.ru.";
  return <main className="mx-auto flex min-h-dvh max-w-lg items-center px-6 text-center"><section className="w-full border-2 border-acid bg-ink p-8 font-mono text-bone"><h1 className="font-display text-3xl uppercase text-acid">{state === "confirmed" ? "Готово" : "FLEXPERIMENT"}</h1><p className="mt-5 leading-relaxed">{text}</p>{state === "invalid" && <a className="mt-5 inline-block text-acid underline underline-offset-4" href="mailto:art@flexperiment.ru">art@flexperiment.ru</a>}</section></main>;
}
