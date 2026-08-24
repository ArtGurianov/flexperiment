"use client";

import { FormEvent, useState } from "react";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import type { CityCatalogueEntry } from "../../../../lib/city-catalog";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";

export function CityEditor({ city, cityOptions, close, done }: { city: Row; cityOptions: readonly CityCatalogueEntry[]; close: () => void; done: () => void }) {
  const [citySlug, setCitySlug] = useState(string(city.slug));
  const [key] = useState(idempotencyKey);

  const mutation = useAdminMutation(
    "city.patch",
    (body: { city_slug: string }) =>
      api(`/cities/${string(city.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
    { context: () => ({ cityId: string(city.id) }) },
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ city_slug: citySlug });
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  };

  return (
    <Dialog title="Редактировать город" close={close} className="editor">
      <form className="form" onSubmit={submit}>
        <p className="eyebrow">CATALOG / CANONICAL CITY</p>
        <h2>Редактировать город</h2>
        <p>Города с уже созданными событиями нельзя переименовать или переназначить: это защищает исторические заказы и публичные URL.</p>
        <div className="form">
          <label>
            Город
            <select value={citySlug} onChange={(event) => setCitySlug(event.target.value)} required>
              {cityOptions.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.title}</option>)}
            </select>
          </label>
        </div>
        <Notice error={mutation.error?.code} />
        <div className="modal-actions">
          <button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Сохраняем…" : "Сохранить изменения"}</button>
        </div>
      </form>
    </Dialog>
  );
}
