"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { labGuestTicketSchema, type LabGuestTicket } from "../../../lib/lab-guest-contract";
import { labRequest, newLabCapability } from "./LabGuestCheckout";

export default function LabGuestTicket() {
  const [ticket, setTicket] = useState<LabGuestTicket | null>(null);
  const [message, setMessage] = useState("");
  const [recovery, setRecovery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const token = useRef<string | null>(null);
  const refundKey = useRef<string | null>(null);
  const lock = useRef(false);
  const load = async () => {
    if (!token.current) return;
    const data = labGuestTicketSchema.parse(await labRequest("/v1/lab/guest/ticket", undefined, token.current));
    setTicket(data);
  };
  useEffect(() => {
    let active = true;
    const initialize = () => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      history.replaceState(null, "", "/ticket");
      let saved: { accessToken?: string } | null = null;
      try { saved = JSON.parse(sessionStorage.getItem("lab-ticket-v1") ?? "null"); } catch { sessionStorage.removeItem("lab-ticket-v1"); }
      if (fragment.has("access")) sessionStorage.removeItem("lab-ticket-recovery-v1");
      const recover = fragment.get("recover") ?? sessionStorage.getItem("lab-ticket-recovery-v1");
      if (recover) {
        sessionStorage.setItem("lab-ticket-recovery-v1", recover);
        queueMicrotask(() => { if (active) setRecovery(recover); }); return;
      }
      token.current = fragment.get("access") ?? saved?.accessToken ?? null;
      if (!token.current) return;
      queueMicrotask(() => { if (active) setRecovery(null); });
      sessionStorage.setItem("lab-ticket-v1", JSON.stringify({ accessToken: token.current }));
      void labRequest("/v1/lab/guest/ticket", undefined, token.current).then(data => { if (active) setTicket(labGuestTicketSchema.parse(data)); })
        .catch(() => { if (active) setMessage("Ссылка недействительна. Восстановите билет по email."); });
    };
    initialize(); window.addEventListener("hashchange", initialize);
    return () => { active = false; window.removeEventListener("hashchange", initialize); };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setMessage("");
    try { await action(); } catch { setMessage("Не удалось выполнить запрос. Повторите или восстановите билет по email."); }
    finally { lock.current = false; setBusy(false); }
  };
  const redeem = () => run(async () => {
    const replacement = sessionStorage.getItem(`lab-ticket-replacement-v1:${recovery}`) ?? newLabCapability();
    sessionStorage.setItem(`lab-ticket-replacement-v1:${recovery}`, replacement);
    await labRequest("/v1/lab/guest/recover/confirm", { recoveryToken: recovery, accessToken: replacement });
    token.current = replacement;
    sessionStorage.setItem("lab-ticket-v1", JSON.stringify({ accessToken: replacement }));
    sessionStorage.removeItem("lab-ticket-recovery-v1"); sessionStorage.removeItem(`lab-ticket-replacement-v1:${recovery}`); setRecovery(null);
    await load();
  });
  const recover = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void run(async () => { await labRequest("/v1/lab/guest/recover", { email: data.get("email"), orderPublicId: data.get("order") || undefined });
      setMessage("Если email соответствует заказу, мы отправили ссылку. Она действует 15 минут."); });
  };
  return <main className="ticketPage"><Link href="/">← Расписание LAB</Link><p className="eyebrow">Flexperiment / LAB</p><h1>Ваш билет</h1>
    {recovery ? <section><p>Подтвердите восстановление: предыдущая ссылка и QR перестанут действовать. Отметка о проходе сохранится.</p><button disabled={busy} onClick={redeem}>Восстановить билет</button></section> : null}
    {ticket && !recovery && <section className="ticketCard"><p className="stamp">{({ VALID: "Билет действителен", USED: "Проход уже отмечен", VOID: "Билет аннулирован", NOT_ISSUED: "Ожидаем подтверждение оплаты" })[ticket.status]}</p>
      {ticket.occurrence && <><h2>{ticket.occurrence.title}</h2><p>{new Date(ticket.occurrence.startsAt).toLocaleString("ru-RU", { timeZone: ticket.occurrence.timezone })}</p>
        <p>{ticket.occurrence.venue.status === "CONFIRMED" ? `${ticket.occurrence.venue.name}, ${ticket.occurrence.venue.address}` : ticket.occurrence.venue.disclosureText}</p></>}
      {ticket.status === "VALID" && ticket.qrImage ? <Image unoptimized src={ticket.qrImage} width={320} height={320} alt="QR для одного прохода на встречу LAB" /> : null}
      {ticket.usedAt && <p>Проход отмечен: {new Date(ticket.usedAt).toLocaleString("ru-RU")}</p>}<p>Заказ: <code>{ticket.orderPublicId}</code></p>
      <button disabled={busy} onClick={() => run(async () => { await labRequest(`/v1/checkout/${encodeURIComponent(ticket.orderPublicId)}`, undefined, token.current!); await load(); })}>Проверить оплату и билет</button>
      {ticket.status === "VALID" || ticket.status === "USED" ? <button disabled={busy} onClick={() => run(async () => {
        refundKey.current ??= crypto.randomUUID();
        await labRequest("/v1/lab/guest/refunds", { reasonCode: "CUSTOMER_REQUEST" }, token.current!, refundKey.current);
        setMessage("Заявка на возврат принята. Решение и выполнение возврата будут отдельно после проверки условий LAB.");
      })}>Запросить возврат</button> : null}
      <p>Аккаунт необязателен. После входа с подтверждённым email заказа билет появится в истории LAB.</p>
    </section>}
    <section><h2>Восстановить по email</h2><p>Укажите email покупки. Номер заказа поможет найти конкретный билет.</p><form onSubmit={recover}>
      <label>Email заказа<input type="email" name="email" required maxLength={254} autoComplete="email" /></label>
      <label>Номер заказа (необязательно)<input name="order" maxLength={128} defaultValue={ticket?.orderPublicId} /></label>
      <button disabled={busy}>Отправить ссылку на билет</button></form></section>
    {message && <p role="status">{message}</p>}
  </main>;
}
