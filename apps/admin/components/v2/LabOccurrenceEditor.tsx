"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, AdminApiError } from "../../lib/api";
import type {
  CitiesResponse,
  CityCreateCommand,
  CityRenameCommand,
  LabOccurrenceCancelCommand,
  LabOccurrenceCreateCommand,
  LabOccurrenceEditCommand,
  LabOccurrencePatch,
  LabOccurrencesResponse,
  LabOfferCommand,
  LabVenueInput,
} from "../../lib/control-room-contracts";
import { Notice } from "../ui/Notice";
import { commercialTermsCommand, commercialTermsDraft, CommercialTermsFields } from "./CommercialTermsFields";

type Occurrence = LabOccurrencesResponse["occurrences"][number];
type City = CitiesResponse["cities"][number];

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const occurrencePath = (occurrenceRef: string) => `/v2/lab/occurrences/${encodeURIComponent(occurrenceRef)}`;
const errorCode = (error: unknown) => error instanceof AdminApiError ? error.code : "CONTROL_ROOM_COMMAND_FAILED";

function useLabCommand<T, R = unknown>(request: (command: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: ["control-room-v2", "lab"] }),
      client.invalidateQueries({ queryKey: ["control-room-v2", "cities"] }),
    ]),
  });
}

type VenueDraft = { status: LabVenueInput["status"]; name: string; address: string; public: boolean; disclosureText: string; announceBy: string };
const venueDraft = (venue: Occurrence["venue"]): VenueDraft => ({
  status: venue?.status ?? "CONFIRMED",
  name: venue?.status === "CONFIRMED" ? venue.name : "",
  address: venue?.status === "CONFIRMED" ? venue.address : "",
  public: venue?.status === "CONFIRMED" ? venue.public : false,
  disclosureText: venue?.status === "TO_BE_ANNOUNCED" ? venue.disclosureText : "",
  announceBy: venue?.status === "TO_BE_ANNOUNCED" ? venue.announceBy : "",
});
const venueInput = (draft: VenueDraft): LabVenueInput => draft.status === "CONFIRMED"
  ? { status: "CONFIRMED", name: draft.name, address: draft.address, public: draft.public }
  : { status: "TO_BE_ANNOUNCED", disclosureText: draft.disclosureText, announceBy: draft.announceBy };

/**
 * The LAB author form (ART-341): a different form from the course editor, sharing only the commercial
 * fields. Schedule and venue are refused by Commerce once a seat is committed; the form does not guess.
 */
function OccurrenceForm({ occurrence, cities, onCreated }: {
  occurrence: Occurrence | null; cities: City[]; onCreated: (occurrenceRef: string) => void;
}) {
  const [occurrenceRef, setOccurrenceRef] = useState(occurrence?.occurrenceRef ?? "lab:");
  const [citySlug, setCitySlug] = useState(occurrence?.citySlug ?? "");
  const [title, setTitle] = useState(occurrence?.title ?? "");
  const [startsAt, setStartsAt] = useState(occurrence?.startsAt ?? "");
  const [endsAt, setEndsAt] = useState(occurrence?.endsAt ?? "");
  const [timezone, setTimezone] = useState(occurrence?.timezone ?? "Europe/Moscow");
  const [capacity, setCapacity] = useState(String(occurrence?.capacity ?? ""));
  const [reserve, setReserve] = useState(String(occurrence?.adminReservedSeats ?? 0));
  const [visibility, setVisibility] = useState<"LISTED" | "UNLISTED">(occurrence?.visibility ?? "UNLISTED");
  const [venue, setVenue] = useState(() => venueDraft(occurrence?.venue ?? null));
  const [reason, setReason] = useState("");
  const create = useLabCommand((command: LabOccurrenceCreateCommand) => api<{ occurrenceRef: string }>("/v2/lab/occurrences", json("POST", command)));
  const edit = useLabCommand((command: LabOccurrenceEditCommand) => api(occurrencePath(occurrence!.occurrenceRef), json("PATCH", command)));
  const pending = create.isPending || edit.isPending;
  const error = create.error ?? edit.error;
  const locked = Boolean(occurrence && occurrence.phase !== "SCHEDULED");
  const sold = (occurrence?.customerCommittedSeats ?? 0) > 0;
  const setVenueField = <K extends keyof VenueDraft>(key: K, value: VenueDraft[K]) => setVenue({ ...venue, [key]: value });

  const submit = () => {
    const venueValue = venueInput(venue);
    if (!occurrence) {
      create.mutate({ occurrenceRef, citySlug, title, startsAt, endsAt, timezone, capacity: Number(capacity),
        adminReservedSeats: Number(reserve), venue: venueValue, reason }, { onSuccess: (result) => onCreated(result.occurrenceRef) });
      return;
    }
    // Only what the operator changed: an untouched schedule never reaches a sold occurrence's lock.
    const patch: LabOccurrencePatch = {};
    if (title !== occurrence.title) patch.title = title;
    if (startsAt !== occurrence.startsAt) patch.startsAt = startsAt;
    if (endsAt !== occurrence.endsAt) patch.endsAt = endsAt;
    if (timezone !== occurrence.timezone) patch.timezone = timezone;
    if (Number(capacity) !== occurrence.capacity) patch.capacity = Number(capacity);
    if (Number(reserve) !== occurrence.adminReservedSeats) patch.adminReservedSeats = Number(reserve);
    if (visibility !== occurrence.visibility) patch.visibility = visibility;
    if (JSON.stringify(venueValue) !== JSON.stringify(occurrence.venue && venueInput(venueDraft(occurrence.venue)))) patch.venue = venueValue;
    edit.mutate({ expectedVersion: occurrence.version, patch, reason });
  };

  return <form className="refund-decision" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <label>Occurrence ref<input required disabled={Boolean(occurrence)} value={occurrenceRef} onChange={(event) => setOccurrenceRef(event.target.value)} /></label>
    <label>Город<select required disabled={Boolean(occurrence)} value={citySlug} onChange={(event) => setCitySlug(event.target.value)}>
      <option value="">Выберите город</option>{cities.map((city) => <option key={city.slug} value={city.slug}>{city.title}</option>)}
    </select></label>
    <label>Название<input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Начало (ISO, UTC)<input required disabled={sold} value={startsAt} onChange={(event) => setStartsAt(event.target.value)} placeholder="2026-11-01T09:00:00Z" /></label>
    <label>Окончание (ISO, UTC)<input required disabled={sold} value={endsAt} onChange={(event) => setEndsAt(event.target.value)} placeholder="2026-11-01T17:00:00Z" /></label>
    <label>Часовой пояс<input required disabled={sold} value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
    <label>Вместимость<input required inputMode="numeric" value={capacity} onChange={(event) => setCapacity(event.target.value)} /></label>
    <label>Резерв организатора<input required inputMode="numeric" value={reserve} onChange={(event) => setReserve(event.target.value)} /></label>
    {occurrence ? <label>Публикация<select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}>
      <option value="UNLISTED">UNLISTED</option><option value="LISTED">LISTED</option>
    </select></label> : null}
    <label>Площадка<select disabled={sold} value={venue.status} onChange={(event) => setVenueField("status", event.target.value as VenueDraft["status"])}>
      <option value="CONFIRMED">CONFIRMED</option><option value="TO_BE_ANNOUNCED">TO_BE_ANNOUNCED</option>
    </select></label>
    {venue.status === "CONFIRMED" ? <>
      <label>Название площадки<input required disabled={sold} value={venue.name} onChange={(event) => setVenueField("name", event.target.value)} /></label>
      <label>Адрес<input required disabled={sold} value={venue.address} onChange={(event) => setVenueField("address", event.target.value)} /></label>
      <label><input type="checkbox" checked={venue.public} onChange={(event) => setVenueField("public", event.target.checked)} /> Адрес в публичном каталоге</label>
    </> : <>
      <label>Текст для покупателя<input required disabled={sold} value={venue.disclosureText} onChange={(event) => setVenueField("disclosureText", event.target.value)} /></label>
      <label>Объявим до (ISO, UTC)<input required disabled={sold} value={venue.announceBy} onChange={(event) => setVenueField("announceBy", event.target.value)} /></label>
    </>}
    {sold ? <small>Есть проданные или оплачиваемые места: дата, время и площадка меняются только через перенос/отмену (ART-203).</small> : null}
    <label className="wide">Причина изменения<input required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    {error ? <Notice error={errorCode(error)} /> : null}
    <button className="primary" disabled={pending || locked}>{pending ? "Сохраняем…" : occurrence ? `Сохранить v${occurrence.version + 1}` : "Создать occurrence"}</button>
  </form>;
}

function LabOfferForm({ occurrence }: { occurrence: Occurrence }) {
  const [terms, setTerms] = useState(() => commercialTermsDraft(occurrence.offer));
  const save = useLabCommand((command: LabOfferCommand) => api(`${occurrencePath(occurrence.occurrenceRef)}/offer`, json("PUT", command)));
  const version = occurrence.offer?.productVersion ?? 0;
  return <form className="refund-decision" aria-label="Оффер occurrence" onSubmit={(event) => {
    event.preventDefault();
    save.mutate({ ...commercialTermsCommand(terms), expectedProductVersion: version });
  }}>
    <CommercialTermsFields value={terms} onChange={setTerms} paid />
    {save.error ? <Notice error={errorCode(save.error)} /> : null}
    <button className="primary" disabled={save.isPending || occurrence.offer?.withdrawn}>{save.isPending ? "Сохраняем…" : `Сохранить оффер v${version + 1}`}</button>
  </form>;
}

function CancelForm({ occurrence }: { occurrence: Occurrence }) {
  const [reason, setReason] = useState("");
  const cancel = useLabCommand((command: LabOccurrenceCancelCommand) => api(`${occurrencePath(occurrence.occurrenceRef)}/cancel`, json("POST", command)));
  return <form className="refund-decision withdrawal" onSubmit={(event) => {
    event.preventDefault();
    cancel.mutate({ expectedVersion: occurrence.version, reason });
  }}>
    <label>Причина отмены<input required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    {occurrence.customerCommittedSeats > 0 ? <small>Есть проданные места: отмена идёт через workflow возвратов (ART-203).</small> : null}
    {cancel.error ? <Notice error={errorCode(cancel.error)} /> : null}
    <button className="danger" disabled={cancel.isPending}>Отменить occurrence</button>
  </form>;
}

export function LabOccurrenceEditor({ occurrence, cities, onCreated }: {
  occurrence: Occurrence | null; cities: City[]; onCreated: (occurrenceRef: string) => void;
}) {
  return <div className="catalogue-editor">
    <OccurrenceForm occurrence={occurrence} cities={cities} onCreated={onCreated} />
    {occurrence && occurrence.phase !== "CANCELLED" ? <LabOfferForm occurrence={occurrence} /> : null}
    {occurrence && occurrence.phase === "SCHEDULED" ? <CancelForm occurrence={occurrence} /> : null}
  </div>;
}

export function CityEditor({ city }: { city: City | null }) {
  const [slug, setSlug] = useState(city?.slug ?? "");
  const [title, setTitle] = useState(city?.title ?? "");
  const create = useLabCommand((command: CityCreateCommand) => api("/v2/cities", json("POST", command)));
  const rename = useLabCommand((command: CityRenameCommand) => api(`/v2/cities/${encodeURIComponent(city!.slug)}`, json("PATCH", command)));
  const error = create.error ?? rename.error;
  return <form className="refund-decision" onSubmit={(event) => {
    event.preventDefault();
    if (city) rename.mutate({ title }); else create.mutate({ slug, title });
  }}>
    <label>Slug<input required disabled={Boolean(city)} value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="nsk" /></label>
    <label>Название<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    {error ? <Notice error={errorCode(error)} /> : null}
    <button className="primary" disabled={create.isPending || rename.isPending}>{city ? "Переименовать" : "Создать город"}</button>
  </form>;
}
