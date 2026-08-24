"use client";

import { useQuery } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { findCityBySlug } from "../../../../lib/city-catalog";
import { parseRublesToKopecks } from "../../../../lib/money";
import { api } from "../../lib/api";
import { minutesToMilliseconds, parseHoursAndMinutes } from "../../lib/duration";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import { cityKeys, occurrenceKeys } from "../../lib/query-keys";
import { POLL_INTERVAL, pollingQuery } from "../../lib/polling";
import type { OccurrenceAction as OccurrenceActionSpec } from "../../lib/occurrence-actions";
import { fromLocalInput, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";
import { MoneyInput } from "../ui/MoneyInput";
import { DurationInput } from "../ui/DurationInput";
import { OccurrenceRow } from "./OccurrenceRow";
import { OccurrenceAction } from "./OccurrenceAction";
import { OccurrenceEditor } from "./OccurrenceEditor";
import { OccurrenceCancellation } from "./OccurrenceCancellation";
import { OccurrenceCompletion } from "./OccurrenceCompletion";

const initialForm = {
  city_id: "", title: "", starts_at: "", duration: "", timezone: "",
  price_kopecks: "", capacity: "", venue_status: "CONFIRMED", venue_name: "",
  venue_address: "", venue_disclosure_text: "Точная площадка будет объявлена позже. Адрес придёт на email и появится в билете.", venue_announcement_lead: "", reason: "",
};

export function Occurrences() {
  const cities = useQuery({ queryKey: cityKeys.list(), queryFn: () => api<{ cities: Row[] }>("/cities") });
  const occurrences = useQuery({
    queryKey: occurrenceKeys.list(),
    queryFn: () => api<{ occurrences: Row[] }>("/occurrences"),
    ...pollingQuery(POLL_INTERVAL.occurrences),
  });

  const [form, setForm] = useState(initialForm);
  const [validationError, setValidationError] = useState<string | null>(null);
  const createKey = usePersistentIdempotencyKey();
  const [action, setAction] = useState<{ occurrence: Row; label: string; patch: OccurrenceActionSpec["patch"] } | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [completing, setCompleting] = useState<Row | null>(null);
  // Accordion: at most one expanded cancellation-financials row at a time —
  // F2, and the input the request budget (§1c) depends on being O(1).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editorConflict, setEditorConflict] = useState(false);
  const set = (field: keyof typeof form, value: string) => setForm((previous) => ({ ...previous, [field]: value }));
  const chooseCity = (cityId: string) => {
    const city = cities.data?.cities.find((entry) => string(entry.id) === cityId);
    const timezone = city ? findCityBySlug(string(city.slug))?.timezone ?? "" : "";
    setForm((previous) => ({ ...previous, city_id: cityId, timezone }));
  };

  const create = useAdminMutation("occurrence.create", ({ body, key }: { body: Row; key: string }) =>
    api("/occurrences", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const startsAt = fromLocalInput(form.starts_at);
    const startsAtMs = Date.parse(startsAt);
    const durationMinutes = parseHoursAndMinutes(form.duration);
    const announcementLeadMinutes = parseHoursAndMinutes(form.venue_announcement_lead);
    if (!Number.isFinite(startsAtMs) || durationMinutes === null || durationMinutes <= 0 || (form.venue_status === "TO_BE_ANNOUNCED" && (announcementLeadMinutes === null || announcementLeadMinutes <= 0))) {
      setValidationError("VALIDATION_ERROR"); return;
    }
    const priceKopecks = parseRublesToKopecks(form.price_kopecks);
    if (priceKopecks === null || priceKopecks <= 0) {
      setValidationError("VALIDATION_ERROR"); return;
    }
    setValidationError(null);
    const key = createKey.acquire();
    const body: Row = {
      city_id: form.city_id,
      title: form.title, starts_at: startsAt, ends_at: new Date(startsAtMs + minutesToMilliseconds(durationMinutes)).toISOString(),
      timezone: form.timezone, price_kopecks: priceKopecks, capacity: Number(form.capacity),
      venue_status: form.venue_status,
    };
    if (form.reason.trim()) body.reason = form.reason.trim();
    if (form.venue_status === "CONFIRMED") { body.venue_name = form.venue_name; body.venue_address = form.venue_address; }
    else { body.venue_disclosure_text = form.venue_disclosure_text; body.venue_announce_by = new Date(startsAtMs - minutesToMilliseconds(announcementLeadMinutes!)).toISOString(); }
    try {
      await create.mutateAsync({ body, key });
      createKey.clear();
      setForm((previous) => ({ ...previous, title: "", starts_at: "", duration: "", price_kopecks: "", capacity: "", venue_name: "", venue_address: "", venue_disclosure_text: initialForm.venue_disclosure_text, venue_announcement_lead: "", reason: "" }));
    } catch {
      // error surfaced via create.error below
    }
  };

  return (
    <>
      <PageTitle
        eyebrow="CATALOG / OCCURRENCES"
        title={<>События<br /><i>без опасных shortcut.</i></>}
        text="Новая occurrence всегда создаётся HIDDEN + CLOSED. Публикация и продажи — отдельные audited действия."
      />
      <section className="panel">
        <h2>Создать событие</h2>
        <form className="form form-grid" onSubmit={submit}>
          <label>
            Город
            <select value={form.city_id} onChange={(event) => chooseCity(event.target.value)} required>
              <option value="" disabled>Выберите город</option>
              {cities.data?.cities.map((city) => <option key={string(city.id)} value={string(city.id)}>{string(city.title)}</option>)}
            </select>
          </label>
          <label>Название<input value={form.title} onChange={(event) => set("title", event.target.value)} required /></label>
          <label>Начало<input type="datetime-local" value={form.starts_at} onChange={(event) => set("starts_at", event.target.value)} required /></label>
          <label>Длительность мастер-класса<DurationInput value={form.duration} onChange={(value) => set("duration", value)} required /></label>
          <label>Цена, ₽<MoneyInput value={form.price_kopecks} onChange={(value) => set("price_kopecks", value)} required /></label>
          <label>Вместимость<input type="number" min="1" step="1" value={form.capacity} onChange={(event) => set("capacity", event.target.value)} required /></label>
          <label>
            Площадка
            <select value={form.venue_status} onChange={(event) => set("venue_status", event.target.value)}>
              <option value="CONFIRMED">Подтверждена</option>
              <option value="TO_BE_ANNOUNCED">Будет объявлена</option>
            </select>
          </label>
          {form.venue_status === "CONFIRMED" ? (
            <>
              <label>Название площадки<input value={form.venue_name} onChange={(event) => set("venue_name", event.target.value)} required /></label>
              <label>Адрес<textarea value={form.venue_address} onChange={(event) => set("venue_address", event.target.value)} required /></label>
            </>
          ) : (
            <>
              <label>Что показывать вместо адреса<textarea value={form.venue_disclosure_text} onChange={(event) => set("venue_disclosure_text", event.target.value)} required /></label>
              <label>Объявить не позднее чем<DurationInput value={form.venue_announcement_lead} onChange={(value) => set("venue_announcement_lead", value)} required /><small>до начала мастер-класса</small></label>
            </>
          )}
          <details className="wide">
            <summary>Дополнительные параметры</summary>
            <label>Timezone<input value={form.timezone} onChange={(event) => set("timezone", event.target.value)} required /></label>
            <label>Причина / audit context<textarea value={form.reason} onChange={(event) => set("reason", event.target.value)} /></label>
          </details>
          <div className="wide">
            <Notice error={validationError ?? create.error?.code} />
            <button className="primary" disabled={create.isPending}>{create.isPending ? "Создаём…" : "Создать скрытое событие"}</button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Все состояния каталога</h2>
        {editorConflict && <Notice>Событие изменилось у другого оператора. Данные перечитаны: откройте запись снова и сверьте изменения.</Notice>}
        <Freshness query={{ ...occurrences, hasData: Boolean(occurrences.data) }} />
        {occurrences.isLoadingError ? <Notice error={(occurrences.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !occurrences.data ? <Loading /> : (
          <div className="occurrence-list" aria-busy={occurrences.isFetching}>
            {occurrences.data.occurrences.map((occurrence) => (
              <OccurrenceRow
                key={string(occurrence.id)}
                occurrence={occurrence}
                expanded={expandedId === string(occurrence.id)}
                onToggleExpand={(id) => setExpandedId((previous) => (previous === id ? null : id))}
                onAction={setAction}
                onEdit={(occurrence) => { setEditorConflict(false); setEditing(occurrence); }}
                onCancel={setCancelling}
                onComplete={setCompleting}
              />
            ))}
          </div>
        )}
      </section>
      {action && <OccurrenceAction action={action} close={() => setAction(null)} done={() => setAction(null)} />}
      {editing && <OccurrenceEditor occurrence={editing} close={() => setEditing(null)} done={() => setEditing(null)} onRevisionConflict={() => { setEditing(null); setEditorConflict(true); }} />}
      {cancelling && <OccurrenceCancellation occurrence={cancelling} close={() => setCancelling(null)} done={() => setCancelling(null)} />}
      {completing && <OccurrenceCompletion occurrence={completing} close={() => setCompleting(null)} done={() => setCompleting(null)} />}
    </>
  );
}
