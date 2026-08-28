"use client";

import { useMemo, useState } from "react";
import NotifyMeForm from "@/components/NotifyMeForm";
import { type CitySlug, requestableCities } from "@/lib/city-catalog";

type Props = { scheduledCitySlugs: CitySlug[] };

export default function CityInterestForm({ scheduledCitySlugs }: Props) {
  const cities = useMemo(() => requestableCities(scheduledCitySlugs), [scheduledCitySlugs]);
  const [city, setCity] = useState("");
  if (!cities.length) return <section className="border border-bone/35 p-4 font-mono text-sm text-bone"><p role="status">Сейчас мы не можем принять запрос для нового города. Пожалуйста, попробуйте позже.</p></section>;
  return <NotifyMeForm endpoint="/v1/public/city-interest" intro="Оставьте email и выберите город — сообщим, если запланируем там мастер-класс." submitLabel="Сообщить о мастер-классе" successText="Запрос сохранён. Сообщим только о мастер-классе в выбранном городе." consentPurpose="для уведомления о мастер-классе в выбранном городе." buildBody={(base) => ({ ...base, city })}>
    <label className="grid gap-1.5">Желаемый город<select required value={city} onChange={(event) => setCity(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid"><option value="" disabled>Выберите город</option>{cities.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.title}</option>)}</select></label>
  </NotifyMeForm>;
}
