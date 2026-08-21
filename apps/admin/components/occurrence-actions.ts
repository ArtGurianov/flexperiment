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

  return [];
}
