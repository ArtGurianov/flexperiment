"use client";

import { useFormFields } from "@payloadcms/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Summary = {
  state?: "UNCONFIGURED";
  version: number;
  accessModel?: "FREE" | "PAID";
  withdrawn?: boolean;
  saleMode?: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  priceKopecks?: number | null;
  controlRoomUrl?: string;
};

export function CourseCommercialSummaryField() {
  const courseRef = useFormFields(([fields]) => fields.courseRef?.value);
  const stableRef = typeof courseRef === "string" && courseRef ? courseRef : null;
  // Reset editor state even for A→B→A; old A responses must not revive its previous state.
  return <CourseCommercialEditor key={stableRef ?? "unsaved"} stableRef={stableRef} />;
}

function CourseCommercialEditor({ stableRef }: { stableRef: string | null }) {
  const active = useRef(true);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [current, setCurrent] = useState<{ ref: string; summary: Summary } | null>(null);
  const [model, setModel] = useState<"FREE" | "PAID">("FREE");
  const [price, setPrice] = useState("0");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ref: string | null; text: string }>({ ref: stableRef, text: "" });
  const setMessage = (text: string) => setNotice({ ref: stableRef, text });
  const message = notice.ref === stableRef ? notice.text : "";
  const [reload, setReload] = useState(0);
  const summary = current?.ref === stableRef ? current.summary : null;
  useEffect(() => {
    if (!stableRef) return;
    const controller = new AbortController();
    void read(stableRef, controller.signal).then(value => {
      if (controller.signal.aborted || !active.current) return;
      setCurrent({ ref: stableRef, summary: value });
      setModel(value.accessModel ?? "FREE"); setPrice(String((value.priceKopecks ?? 0) / 100));
      if (reload > 0) setNotice({ ref: stableRef, text: "Свежие данные Commerce загружены. Повторная запись не выполнялась." });
    }).catch(() => { if (!controller.signal.aborted && active.current) setCurrent(null); });
    return () => controller.abort();
  }, [stableRef, reload]);
  const save = async () => {
    if (!stableRef || !summary || busy || summary.withdrawn) return;
    const ref = stableRef;
    const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(price);
    const priceKopecks = model === "FREE" ? 0 : match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : NaN;
    if (!Number.isSafeInteger(priceKopecks) || (model === "PAID" && priceKopecks <= 0)) { setMessage("Укажите положительную цену с точностью до копейки."); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint(ref), { method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessModel: model, priceKopecks, expectedVersion: summary.version, commandKey: crypto.randomUUID() }) });
      const result = await response.json() as { version?: number; code?: string; cacheRefresh?: string };
      if (!active.current) return;
      if (!response.ok) {
        if (result.code === "CATALOG_VERSION_CONFLICT") throw new Error("Версия изменилась. Обновите данные перед сохранением.");
        if (result.code === "FREE_ACCESS_HISTORY_REQUIRES_RECONCILIATION") throw new Error("Смена модели заблокирована: требуется сверка прежнего бесплатного доступа.");
        throw new Error("Сохранение не подтверждено. Обновите данные; не повторяйте запись вслепую.");
      }
      const confirmed = await read(ref).catch(() => { throw new Error("Запись могла быть сохранена. Обновите данные для сверки; новый POST не требуется."); });
      if (!active.current) return;
      if (confirmed.version !== result.version || confirmed.accessModel !== model || confirmed.priceKopecks !== priceKopecks
        || confirmed.saleMode !== "CLOSED") throw new Error("Независимая проверка не подтвердила запись. Обновите данные.");
      setCurrent({ ref, summary: confirmed });
      setMessage(result.cacheRefresh === "PENDING" ? "Commerce подтвердил запись; обновление витрины ожидается. Продажи закрыты." : "Commerce подтвердил запись. Продажи закрыты.");
    } catch (error) {
      if (active.current) { setCurrent(null); setMessage(error instanceof Error ? error.message : "Сохранение не подтверждено."); }
    } finally { if (active.current) setBusy(false); }
  };
  return <div style={{ border: "1px solid var(--theme-elevation-200)", borderRadius: 4, padding: 16, marginBottom: 20 }}>
    <strong>Доступ и цена — Commerce</strong>
    {!stableRef && <p>Сначала сохраните курс для получения стабильного courseRef.</p>}
    {stableRef && !summary && <p>Свежие данные Commerce не загружены. Сохранение заблокировано.</p>}
    {summary && <>
      <p>{summary.state === "UNCONFIGURED" ? "Продукт ещё не настроен." : `Версия ${summary.version} · Продажи: ${summary.saleMode}`}</p>
      <label>Доступ <select aria-label="Доступ" value={model} disabled={busy || summary.withdrawn} onChange={event => setModel(event.target.value as "FREE" | "PAID")}>
        <option value="FREE">Бесплатный</option><option value="PAID">Платный</option>
      </select></label>
      {model === "PAID" && <label> Цена, ₽ <input aria-label="Цена, ₽" inputMode="decimal" value={price} disabled={busy || summary.withdrawn} onChange={event => setPrice(event.target.value)} /></label>}
      <p>FREE — 0 ₽, без checkout. Настройка PAID не открывает продажи и не изменяет ранее созданные заказы.</p>
      {summary.withdrawn && <p>Курс отозван; изменение коммерческих условий запрещено.</p>}
    </>}
    <button type="button" disabled={!summary || busy || summary.withdrawn} onClick={() => void save()}>Сохранить в Commerce</button>{" "}
    <button type="button" disabled={!stableRef || busy} onClick={() => { setCurrent(null); setReload(value => value + 1); }}>Обновить данные</button>
    <p role="status">{message}</p>
    {summary?.controlRoomUrl && <a href={summary.controlRoomUrl} rel="noreferrer" target="_blank">Control Room: активация продаж и остальные настройки</a>}
  </div>;
}

const endpoint = (ref: string) => `/api/courses/commercial-summary/${encodeURIComponent(ref)}`;
const read = async (ref: string, signal?: AbortSignal): Promise<Summary> => {
  const response = await fetch(endpoint(ref), { cache: "no-store", signal });
  if (!response.ok) throw new Error("COMMERCE_UNAVAILABLE");
  const result = await response.json() as Summary;
  if (!Number.isSafeInteger(result.version) || result.version < 0) throw new Error("COMMERCE_RESULT_INVALID");
  return result;
};
