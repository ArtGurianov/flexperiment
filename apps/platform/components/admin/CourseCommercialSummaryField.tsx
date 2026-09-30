"use client";

import { useFormFields } from "@payloadcms/ui";
import { useEffect, useState } from "react";

type Summary = {
  state?: "UNCONFIGURED";
  accessModel?: "FREE" | "PAID";
  withdrawn?: boolean;
  saleMode?: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  priceKopecks?: number | null;
  controlRoomUrl?: string;
};

export function CourseCommercialSummaryField() {
  const courseRef = useFormFields(([fields]) => fields.courseRef?.value);
  const stableRef = typeof courseRef === "string" && courseRef ? courseRef : null;
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    if (!stableRef) return;
    const controller = new AbortController();
    void fetch(`/api/courses/commercial-summary/${encodeURIComponent(stableRef)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json()).then(setSummary).catch(() => setSummary(null));
    return () => controller.abort();
  }, [stableRef]);
  const price = typeof summary?.priceKopecks === "number" ? new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(summary.priceKopecks / 100) : "—";
  return <div style={{ border: "1px solid var(--theme-elevation-200)", borderRadius: 4, padding: 16, marginBottom: 20 }}><strong>Коммерческий статус (только чтение)</strong>{!stableRef && <p>Сохраните курс, чтобы получить стабильный courseRef.</p>}{stableRef && !summary && <p>Commerce недоступен.</p>}{summary?.state === "UNCONFIGURED" && <p>Продукт ещё не настроен — на витрине будет «Скоро».</p>}{summary?.accessModel && <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 18px" }}><dt>Доступ</dt><dd>{summary.accessModel}</dd><dt>Продажи</dt><dd>{summary.saleMode}</dd><dt>Цена</dt><dd>{price}</dd><dt>Отозван</dt><dd>{summary.withdrawn ? "Да" : "Нет"}</dd></dl>}{summary?.controlRoomUrl ? <p><a href={summary.controlRoomUrl} rel="noreferrer" target="_blank">Изменить в Control Room</a></p> : null}</div>;
}
