import { occurrenceActionsFor, type OccurrenceAction as OccurrenceActionSpec } from "../../lib/occurrence-actions";
import { formatDate, formatMoney, number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { CancellationFinancialOverview } from "./CancellationFinancialOverview";

export function OccurrenceRow({ occurrence, expanded, onToggleExpand, onAction, onEdit, onCancel, onComplete }: {
  occurrence: Row;
  expanded: boolean;
  onToggleExpand: (occurrenceId: string) => void;
  onAction: (next: { occurrence: Row; label: string; patch: OccurrenceActionSpec["patch"] }) => void;
  onEdit: (occurrence: Row) => void;
  onCancel: (occurrence: Row) => void;
  onComplete: (occurrence: Row) => void;
}) {
  const actions = occurrenceActionsFor(occurrence);
  // The server clock is authoritative for the end-time gate. Rendering this
  // action for a closed scheduled occurrence avoids a client-clock decision.
  const canComplete = string(occurrence.fulfillment_status) === "SCHEDULED" && string(occurrence.sales_status) === "CLOSED";
  const cancelled = string(occurrence.fulfillment_status) === "CANCELLED";
  return (
    <article className="occurrence-row">
      <div>
        <p className="eyebrow">{string(occurrence.city_title)} / {string(occurrence.city_slug)}</p>
        <h3>{string(occurrence.title)}</h3>
        <p>{formatDate(occurrence.starts_at)} · {formatMoney(occurrence.price_kopecks)} · {number(occurrence.availability)} / {number(occurrence.capacity)} мест</p>
        <code>{string(occurrence.id)}</code>
      </div>
      <div className="state-stack">
        <Badge>{string(occurrence.visibility)}</Badge>
        <Badge>{string(occurrence.sales_status)}</Badge>
        <Badge>{string(occurrence.fulfillment_status)}</Badge>
      </div>
      <div className="action-stack">
        {string(occurrence.fulfillment_status) === "SCHEDULED" && <button className="danger" onClick={() => onCancel(occurrence)}>Отменить событие</button>}
        {canComplete && <button onClick={() => onComplete(occurrence)}>Отметить проведённым</button>}
        <button onClick={() => onEdit(occurrence)}>Редактировать</button>
        {actions.map((action) => <button key={action.label} onClick={() => onAction({ occurrence, label: action.label, patch: action.patch })}>{action.label}</button>)}
        {cancelled && <button onClick={() => onToggleExpand(string(occurrence.id))}>{expanded ? "Скрыть финансы" : "Показать финансы"}</button>}
      </div>
      {cancelled && expanded && <CancellationFinancialOverview occurrenceId={string(occurrence.id)} />}
    </article>
  );
}
