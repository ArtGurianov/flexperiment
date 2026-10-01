"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function CheckoutReturnPage() {
  const router = useRouter();
  const [message, setMessage] = useState("Проверяем защищённый возврат из Refref…");

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const state = query.get("state") ?? "";
    const rt = query.get("rt") ?? "";
    if (!state) {
      queueMicrotask(() => setMessage("В ссылке возврата не хватает данных."));
      return;
    }
    void fetch(`/v1/checkout/handoff/return?state=${encodeURIComponent(state)}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json() as { phase?: "HANDOFF" | "PAYMENT_RETURN"; returnPath?: string; orderPublicId?: string };
        if (!response.ok || !body.returnPath || !body.orderPublicId || !body.phase) throw new Error("CHECKOUT_STATE_INVALID");
        const target = new URL(body.returnPath, window.location.origin);
        if (body.phase === "HANDOFF") {
          if (!rt) throw new Error("CHECKOUT_HANDOFF_TOKEN_REQUIRED");
          target.searchParams.set("rt", rt);
          target.searchParams.set("state", state);
          router.replace(`${target.pathname}${target.search}`);
          return;
        }
        setMessage("Платёж принят. Открываем доступ…");
        const payment = await fetch(`/v1/checkout/${encodeURIComponent(body.orderPublicId)}`, { cache: "no-store", credentials: "same-origin" });
        const result = await payment.json() as { state?: string };
        target.searchParams.set("payment", result.state === "PAID" ? "paid" : "pending");
        if (!payment.ok || result.state !== "PAID") target.searchParams.set("order", body.orderPublicId);
        router.replace(`${target.pathname}${target.search}`);
      })
      .catch(() => setMessage("Не удалось подтвердить возврат. Начните оплату снова со страницы курса."));
  }, [router]);

  return <main className="accountPage"><section className="accountPanel"><p className="eyebrow">Оплата</p><h1>Возвращаемся к курсу</h1><p role="status">{message}</p></section></main>;
}
