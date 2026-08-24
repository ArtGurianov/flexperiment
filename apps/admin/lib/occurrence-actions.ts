export type OccurrenceAction = {
  label: string;
  patch: Record<string, "PUBLISHED" | "HIDDEN" | "OPEN" | "PAUSED" | "CLOSED">;
};

/**
 * Presentation-only action availability derived from the last authoritative
 * occurrence response. This does not predict transitions or mutate state.
 */
export function occurrenceActionsFor(occurrence: { visibility?: unknown; sales_status?: unknown }): OccurrenceAction[] {
  const visibility = typeof occurrence.visibility === "string" ? occurrence.visibility : "";
  const salesStatus = typeof occurrence.sales_status === "string" ? occurrence.sales_status : "";
  const state = `${visibility}:${salesStatus}`;

  if (state === "HIDDEN:CLOSED") return [{ label: "Опубликовать", patch: { visibility: "PUBLISHED" } }];
  if (state === "PUBLISHED:CLOSED") return [
    { label: "Открыть продажи", patch: { sales_status: "OPEN" } },
    { label: "Скрыть", patch: { visibility: "HIDDEN" } },
  ];
  if (state === "PUBLISHED:OPEN") return [
    { label: "Пауза", patch: { sales_status: "PAUSED" } },
    { label: "Закрыть", patch: { sales_status: "CLOSED" } },
  ];
  if (state === "PUBLISHED:PAUSED") return [
    { label: "Открыть продажи", patch: { sales_status: "OPEN" } },
    { label: "Закрыть", patch: { sales_status: "CLOSED" } },
  ];
  if (state === "HIDDEN:OPEN" || state === "HIDDEN:PAUSED") {
    return [{ label: "Закрыть продажи", patch: { sales_status: "CLOSED" } }];
  }

  return [];
}

/**
 * B4: the confirmation modal must show what the operator asked for and what
 * it does — never the raw target-state enum as if it were a headline.
 */
export function occurrenceActionConsequence(patch: OccurrenceAction["patch"]): string {
  if (patch.visibility === "PUBLISHED") return "Событие станет видно в публичном каталоге.";
  if (patch.visibility === "HIDDEN") return "Событие исчезнет из публичного каталога. Это не отменяет событие и не трогает существующие брони.";
  if (patch.sales_status === "OPEN") return "Продажи откроются: гости смогут бронировать и оплачивать места.";
  if (patch.sales_status === "PAUSED") return "Продажи будут приостановлены. Существующие брони не меняются.";
  if (patch.sales_status === "CLOSED") return "Продажи закроются для новых бронирований. Существующие брони не меняются.";
  return "";
}
