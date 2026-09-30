"use client";

import { useEffect, useState } from "react";

export default function CheckoutReturnPage() {
  const [message, setMessage] = useState("Проверяем защищённый возврат из Refref…");

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const state = query.get("state") ?? "";
    const rt = query.get("rt") ?? "";
    if (!state || !rt) {
      queueMicrotask(() => setMessage("В ссылке возврата не хватает данных."));
      return;
    }
    void fetch(`/v1/checkout/handoff/return?state=${encodeURIComponent(state)}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json() as { returnPath?: string };
        if (!response.ok || !body.returnPath) throw new Error("CHECKOUT_STATE_INVALID");
        const target = new URL(body.returnPath, window.location.origin);
        target.searchParams.set("rt", rt);
        target.searchParams.set("state", state);
        window.location.replace(target.toString());
      })
      .catch(() => setMessage("Не удалось подтвердить возврат. Начните оплату снова со страницы курса."));
  }, []);

  return <main className="accountPage"><section className="accountPanel"><p className="eyebrow">Оплата</p><h1>Возвращаемся к курсу</h1><p role="status">{message}</p></section></main>;
}
