"use client";

import { useEffect, useState } from "react";
import { commerceApiUrl } from "@/lib/commerce-api";

export default function TicketViewer() {
  const [result, setResult] = useState<"loading" | "ready" | "error">("loading");
  const [ticket, setTicket] = useState<{ id: string; title: string; starts_at: string; venue_name?: string; venue_address?: string; participant_age_band: "ADULT" | "MINOR_14_17" | "MINOR_UNDER_14" | null; requires_adult_accompaniment?: number; status: string } | null>(null);
  useEffect(() => {
    const capability = window.location.hash.slice(1);
    history.replaceState(null, "", "/ticket");
    if (!capability) { queueMicrotask(() => setResult("error")); return; }
    fetch(commerceApiUrl("/v1/public/ticket"), { headers: { Authorization: `Bearer ${capability}` }, cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : Promise.reject())
      .then((data) => { setTicket(data); setResult("ready"); })
      .catch(() => setResult("error"));
  }, []);
  const ageBandLabel = { ADULT: "18 лет и старше", MINOR_14_17: "14–17 лет", MINOR_UNDER_14: "младше 14 лет" } as const;
  return <main className="mx-auto flex min-h-dvh max-w-lg items-center px-6 text-center"><div className="w-full border-2 border-acid bg-ink p-8 font-mono text-bone"><h1 className="font-display text-3xl uppercase text-acid">Билет</h1>{result === "loading" && <p className="mt-4">Открываем билет…</p>}{result === "error" && <p className="mt-4">Ссылка на билет недействительна или больше недоступна.</p>}{ticket && <div className="mt-4 space-y-2"><p>{ticket.title}</p><p>{new Date(ticket.starts_at).toLocaleString("ru-RU")}</p><p>{ticket.venue_name} {ticket.venue_address}</p>{ticket.participant_age_band && <p>Категория участника: {ageBandLabel[ticket.participant_age_band]}</p>}{Boolean(ticket.requires_adult_accompaniment) && <p className="border border-acid p-2 text-acid">Посещение только в сопровождении взрослого.</p>}<p>Идентификатор билета: {ticket.id}</p><p>{ticket.status === "VOID" ? "Билет аннулирован" : "Билет действителен"}</p></div>}</div></main>;
}
