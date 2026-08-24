"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { parseRublesToKopecks } from "../../../../lib/money";
import { api, idempotencyKey } from "../../lib/api";
import { formatDurationBetween, minutesToMilliseconds, parseHoursAndMinutes } from "../../lib/duration";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { fromLocalInput, number, string, toLocalInput } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { DurationInput } from "../ui/DurationInput";
import { Notice } from "../ui/Notice";
import { MoneyInput } from "../ui/MoneyInput";

const DEFAULT_VENUE_DISCLOSURE = "Точная площадка будет объявлена позже. Адрес придёт на email и появится в билете.";

export function OccurrenceEditor({ occurrence, close, done, onRevisionConflict }: { occurrence: Row; close: () => void; done: () => void; onRevisionConflict: () => void }) {
  const { control, register, handleSubmit, watch } = useForm({ shouldUnregister: true, defaultValues: {
    title: string(occurrence.title),
    starts_at: toLocalInput(occurrence.starts_at),
    duration: formatDurationBetween(occurrence.starts_at, occurrence.ends_at),
    timezone: string(occurrence.timezone),
    price_kopecks: String(number(occurrence.price_kopecks) / 100),
    capacity: String(number(occurrence.capacity)),
    venue_status: string(occurrence.venue_status),
    venue_name: string(occurrence.venue_name),
    venue_address: string(occurrence.venue_address),
    venue_disclosure_text: string(occurrence.venue_disclosure_text) || DEFAULT_VENUE_DISCLOSURE,
    venue_announcement_lead: formatDurationBetween(occurrence.venue_announce_by, occurrence.starts_at),
  } });
  const [key] = useState(idempotencyKey);
  const [validationError, setValidationError] = useState<string | null>(null);

  const mutation = useAdminMutation(
    "occurrence.patch",
    (body: Row) => api(`/occurrences/${string(occurrence.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
    {
      context: () => ({ occurrenceId: string(occurrence.id) }),
      onError: (error) => {
        if (error.code === "OCCURRENCE_REVISION_CONFLICT") onRevisionConflict();
      },
    },
  );

  const submit = handleSubmit(async (form) => {
    const startsAt = fromLocalInput(form.starts_at);
    const startsAtMs = Date.parse(startsAt);
    const durationMinutes = parseHoursAndMinutes(form.duration);
    const announcementLeadMinutes = parseHoursAndMinutes(form.venue_announcement_lead);
    if (!Number.isFinite(startsAtMs) || durationMinutes === null || durationMinutes <= 0 || (form.venue_status === "TO_BE_ANNOUNCED" && (announcementLeadMinutes === null || announcementLeadMinutes <= 0))) {
      setValidationError("VALIDATION_ERROR"); return;
    }
    const priceKopecks = parseRublesToKopecks(form.price_kopecks);
    const occupied = Math.max(0, number(occurrence.capacity) - number(occurrence.availability));
    if (priceKopecks === null || priceKopecks < 0 || Number(form.capacity) < occupied) {
      setValidationError(priceKopecks === null ? "VALIDATION_ERROR" : "CAPACITY_BELOW_OCCUPANCY"); return;
    }
    setValidationError(null);
    const body: Row = { title: form.title, starts_at: startsAt, ends_at: new Date(startsAtMs + minutesToMilliseconds(durationMinutes)).toISOString(), timezone: form.timezone, price_kopecks: priceKopecks, capacity: Number(form.capacity), venue_status: form.venue_status };
    if (form.venue_status === "CONFIRMED") {
      body.venue_name = form.venue_name; body.venue_address = form.venue_address; body.venue_disclosure_text = null; body.venue_announce_by = null;
    } else {
      body.venue_name = null; body.venue_address = null; body.venue_disclosure_text = form.venue_disclosure_text; body.venue_announce_by = new Date(startsAtMs - minutesToMilliseconds(announcementLeadMinutes!)).toISOString();
    }
    try {
      await mutation.mutateAsync({ ...body, expected_revision: number(occurrence.admin_revision) });
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  });
  const occupied = Math.max(0, number(occurrence.capacity) - number(occurrence.availability));
  const venueStatus = watch("venue_status");
  const capacityBelowOccupancy = Number(watch("capacity")) < occupied;

  return (
    <Dialog title="Редактировать событие" close={close} className="editor">
      <form className="form" onSubmit={submit}>
        <p className="eyebrow">CATALOG / MATERIAL EDIT</p>
        <h2>Редактировать событие</h2>
        <div className="form form-grid">
          <label>Название<input {...register("title", { required: true })} /></label>
          <label>Timezone<input {...register("timezone", { required: true })} /></label>
          <label>Начало<input type="datetime-local" {...register("starts_at", { required: true })} /></label>
          <label>Длительность мастер-класса<Controller control={control} name="duration" rules={{ required: true }} render={({ field }) => <DurationInput value={field.value} onChange={field.onChange} required />} /></label>
          <label>Цена, ₽<Controller control={control} name="price_kopecks" rules={{ required: true }} render={({ field }) => <MoneyInput value={field.value} onChange={field.onChange} required />} /></label>
          <label>Вместимость<input type="number" min={occupied} {...register("capacity", { required: true })} /><small>Свободно: {number(occurrence.availability)} из {number(occurrence.capacity)}; занято (reserved + confirmed): {occupied}.</small>{capacityBelowOccupancy && <small className="notice notice-error">Новая вместимость ниже уже занятых мест.</small>}</label>
          <label className="wide">
            Площадка
            <select {...register("venue_status")}>
              <option value="CONFIRMED">Подтверждена</option>
              <option value="TO_BE_ANNOUNCED">Будет объявлена</option>
            </select>
          </label>
          {venueStatus === "CONFIRMED" ? (
            <>
              <label>Название площадки<input {...register("venue_name", { required: true })} /></label>
              <label>Адрес<textarea {...register("venue_address", { required: true })} /></label>
            </>
          ) : (
            <>
              <label>Что показывать вместо адреса<textarea {...register("venue_disclosure_text", { required: true })} /></label>
              <label>Объявить не позднее чем<Controller control={control} name="venue_announcement_lead" rules={{ required: true }} render={({ field }) => <DurationInput value={field.value} onChange={field.onChange} required />} /><small>до начала мастер-класса</small></label>
            </>
          )}
        </div>
        <Notice error={validationError ?? mutation.error?.code} />
        <div className="modal-actions">
          <button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Сохраняем…" : "Сохранить изменения"}</button>
        </div>
      </form>
    </Dialog>
  );
}
