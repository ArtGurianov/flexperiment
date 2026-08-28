"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "../../lib/api";
import { dashboardKeys } from "../../lib/query-keys";
import { POLL_INTERVAL, pollingQuery } from "../../lib/polling";
import { formatDate, formatMoney, maybeNumber, number, renderMaybe, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";
import { Loading } from "../ui/Loading";
import { Metric } from "../ui/Metric";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { Freshness } from "../ui/Freshness";
import { SalesControl } from "./SalesControl";

type DashboardResponse = { today: Row; health: Record<string, Row>; upcoming: Row[]; sales_control: { effective_status: "OPEN" | "PAUSED"; emergency: { sales_paused: boolean; revision: number; paused_at: string | null; paused_reason: string | null }; release_paused: boolean } };

// Every destination filter here has a backend test asserting its predicate
// equals the counter's predicate (commerce/test/api.test.ts) — D3.
const HEALTH_ROWS: { key: string; label: string; href: string }[] = [
  { key: "create_unknown", label: "CREATE_UNKNOWN", href: "/orders/?payment_state=CREATE_UNKNOWN" },
  { key: "review_required_payments", label: "REVIEW_REQUIRED (payments)", href: "/orders/?payment_status=REVIEW_REQUIRED" },
  { key: "review_required_refunds", label: "REVIEW_REQUIRED (refunds)", href: "/refunds/?status=REVIEW_REQUIRED" },
  { key: "pending_refunds", label: "Pending refunds", href: "/refunds/?status=REQUESTED&status=SUBMITTING&status=SUBMIT_UNKNOWN&status=RECONCILING" },
  { key: "email_attention", label: "Email attention", href: "/email-attention/" },
  { key: "stale_prepared_settlements", label: "Stale PREPARED", href: "/settlements/?stale_prepared=1" },
  { key: "operational_incidents", label: "Operational incidents", href: "/incidents/?status=OPEN" },
];

export function Dashboard() {
  const query = useQuery({
    queryKey: dashboardKeys.summary(),
    queryFn: () => api<DashboardResponse>("/dashboard"),
    ...pollingQuery(POLL_INTERVAL.dashboard),
    // No placeholderData here: the dashboard is one query, not a filtered
    // list — keepPreviousData exists to bridge a filter transition, and
    // applying it here would risk the exact bug class P0 removes (E3).
  });

  if (query.isLoadingError) return <Notice error={(query.error as { code?: string } | null)?.code ?? "UNKNOWN"} />;
  if (!query.data) return <Loading />;

  const today = query.data.today;
  const health = query.data.health;

  return (
    <>
      <section className="hero">
        <p className="eyebrow">OPERATIONAL OVERVIEW / TODAY</p>
        <h1>Данные без<br /><i>магии статусов.</i></h1>
        <p>Commerce и SQLite остаются источником истины. Этот экран ничего не мутирует.</p>
      </section>
      <Freshness query={{ ...query, hasData: Boolean(query.data) }} />
      <section className="metrics">
        <Metric label="Заказы" value={number(today.orders)} />
        <Metric label="Получено" value={formatMoney(today.revenue_kopecks)} />
        <Metric label="Возвращено" value={formatMoney(today.refunded_kopecks)} />
      </section>
      <section className="two-col">
        {query.data.sales_control ? <SalesControl control={query.data.sales_control} /> : null}
        <Panel title="Операционное внимание">
          <div className="signal-list">
            {HEALTH_ROWS.map((row) => {
              const count = maybeNumber(health[row.key]?.count);
              return (
                <Link href={row.href} key={row.key} className="signal-row">
                  <span>{row.label}</span>
                  <strong className={count.known && count.value > 0 ? "signal-hot" : ""}>{renderMaybe(count, String)}</strong>
                </Link>
              );
            })}
          </div>
        </Panel>
        <Panel title="Ближайшие события">
          {query.data.upcoming.length ? (
            <div className="upcoming-list">
              {query.data.upcoming.map((item) => (
                <div className="upcoming-card" key={string(item.id)}>
                  <div className="upcoming-meta">
                    <span>{string(item.city_title)}</span>
                    <Badge>{string(item.sales_status)}</Badge>
                  </div>
                  <strong>{string(item.title)}</strong>
                  <small>{formatDate(item.starts_at)} · {number(item.availability)} / {number(item.capacity)} мест</small>
                </div>
              ))}
            </div>
          ) : (
            <Empty label="Нет запланированных событий." />
          )}
        </Panel>
      </section>
    </>
  );
}
