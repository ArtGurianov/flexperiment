import { formatDate, number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";

export function EmailIncidentTable({ incidents, acknowledge, empty }: { incidents: Row[]; acknowledge?: (incident: Row) => void; empty: string }) {
  if (!incidents.length) return <Empty label={empty} />;
  return (
    <table>
      <thead>
        <tr><th>Создан</th><th>Тип / статус</th><th>Попытки / время</th><th>Provider evidence</th><th>Заказ</th><th>Рассмотрение</th></tr>
      </thead>
      <tbody>
        {incidents.map((incident) => (
          <tr key={string(incident.id)}>
            <td>{formatDate(incident.created_at)}<small>{string(incident.id)}</small></td>
            <td><Badge>{string(incident.type)}</Badge><Badge>{string(incident.status)}</Badge></td>
            <td>
              {number(incident.attempts)}
              <small>sent: {formatDate(incident.sent_at)}</small>
              <small>delivered: {formatDate(incident.delivered_at)}</small>
              <small>bounced: {formatDate(incident.bounced_at)}</small>
            </td>
            <td><code>{string(incident.provider_error_code) || "—"}</code><small>{string(incident.provider_error_message) || "—"}</small></td>
            <td>{string(incident.public_order_number) || "—"}<small>{string(incident.order_id)}</small></td>
            <td>
              {incident.ops_acknowledged_at ? (
                <>
                  <Badge>ACKNOWLEDGED</Badge>
                  <small>{formatDate(incident.ops_acknowledged_at)}</small>
                  <small>{string(incident.ops_acknowledged_reason)}</small>
                </>
              ) : acknowledge ? <button onClick={() => acknowledge(incident)}>Отметить рассмотренным</button> : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
