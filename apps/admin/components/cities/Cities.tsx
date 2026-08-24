"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import { cityKeys } from "../../lib/query-keys";
import { number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { CITY_CATALOGUE, type CityCatalogueEntry } from "../../../../lib/city-catalog";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";
import { CityEditor } from "./CityEditor";

export function Cities() {
  const cities = useQuery({ queryKey: cityKeys.list(), queryFn: () => api<{ cities: Row[] }>("/cities") });
  const { register, handleSubmit, reset } = useForm<{ citySlug: string }>({ defaultValues: { citySlug: "" } });
  const [editing, setEditing] = useState<Row | null>(null);
  const createKey = usePersistentIdempotencyKey();
  const cityOptions = useMemo(() => [...CITY_CATALOGUE].sort((left, right) => left.title.localeCompare(right.title, "ru")), []);

  const create = useAdminMutation("city.create", ({ body, key }: { body: { city_slug: string }; key: string }) =>
    api("/cities", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));

  const submit = handleSubmit(async ({ citySlug }) => {
    try {
      await create.mutateAsync({ body: { city_slug: citySlug }, key: createKey.acquire() });
      createKey.clear();
      reset();
    } catch {
      // error surfaced via create.error below
    }
  });

  return (
    <>
      <PageTitle
        eyebrow="CATALOG / GEOGRAPHY"
        title={<>Города<br /><i>тура.</i></>}
        text="Создание — audited command с сохранённым idempotency key. Город сам по себе не появляется в public catalog."
      />
      <section className="two-col catalog-grid">
        <Panel title="Существующие города">
          <Freshness query={{ ...cities, hasData: Boolean(cities.data) }} />
          {cities.isLoadingError ? <Notice error={(cities.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !cities.data ? <Loading /> : (
            <table>
              <thead><tr><th>Город</th><th>Slug</th><th>События</th><th></th></tr></thead>
              <tbody>
                {cities.data.cities.map((city) => (
                  <tr key={string(city.id)}>
                    <td><strong>{string(city.title)}</strong><small>{string(city.id)}</small></td>
                    <td><code>{string(city.slug)}</code></td>
                    <td>{number(city.occurrence_count)}</td>
                    <td><button onClick={() => setEditing(city)}>Редактировать</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Добавить город">
          <form className="form" onSubmit={submit}>
            <label>
              Город
              <select {...register("citySlug", { required: true })}>
                <option value="" disabled>Выберите город</option>
                {cityOptions.map((city) => <option key={city.slug} value={city.slug}>{city.title}</option>)}
              </select>
            </label>
            <Notice error={create.error?.code} />
            <button className="primary" disabled={create.isPending}>{create.isPending ? "Создаём…" : "Создать город"}</button>
          </form>
        </Panel>
      </section>
      {editing && (
        <CityEditor
          city={editing}
          cityOptions={cityOptions as readonly CityCatalogueEntry[]}
          close={() => setEditing(null)}
          done={() => setEditing(null)}
        />
      )}
    </>
  );
}
