"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { commerceApiUrl } from "../../../lib/commerce-api";

/** Confirms or withdraws a LAB pre-registration from the link fragment, which never reaches a server log. */
export default function LabInterestLink() {
  const [state, setState] = useState<"working" | "confirmed" | "withdrawn" | "invalid" | "error">("working");
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const confirm = params.get("confirm"), withdraw = params.get("withdraw");
    history.replaceState(null, "", window.location.pathname);
    if (!confirm && !withdraw) { void Promise.resolve().then(() => setState("invalid")); return; }
    void fetch(commerceApiUrl(confirm ? "/v1/lab/interest/confirm" : "/v1/lab/interest/withdraw"), {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: confirm ?? withdraw }),
    }).then((response) => setState(response.ok ? (confirm ? "confirmed" : "withdrawn") : response.status === 422 ? "invalid" : "error"))
      .catch(() => setState("error"));
  }, []);
  return <main><header><Link href="/" className="wordmark">FLEXPERIMENT<span> / LAB</span></Link></header>
    <section aria-live="polite">{{
      working: <p role="status">Проверяем ссылку…</p>,
      confirmed: <p role="status">Предзапись подтверждена. Мы пришлём одно письмо, когда откроются продажи. Место не резервируется.</p>,
      withdrawn: <p role="status">Вы отказались от уведомлений. Заявка удалена, писем о старте продаж не будет.</p>,
      invalid: <p role="alert">Ссылка недействительна или устарела. Оставьте предзапись заново на главной странице.</p>,
      error: <p role="alert">Не удалось обработать ссылку. Повторите попытку позже.</p>,
    }[state]}<Link href="/">Вернуться к расписанию LAB</Link></section></main>;
}
