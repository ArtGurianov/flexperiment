import { formatRubles } from "../../../lib/money";

export const string = (value: unknown) => (typeof value === "string" ? value : "");

export const number = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0));

export const formatMoney = (value: unknown) => formatRubles(number(value));

export const formatDate = (value: unknown) => {
  const date = new Date(string(value));
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
};

/** For epoch-ms timestamps (React Query's dataUpdatedAt/errorUpdatedAt),
 * which formatDate can't handle — it only accepts strings via string(). */
export const formatTimestamp = (ms: number) =>
  ms > 0 ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms)) : "—";

export const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : "");

export const toLocalInput = (value: unknown) => {
  const date = new Date(string(value));
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

/**
 * A missing counter is not zero — it's unknown, and must render as unknown.
 * `number()`/`formatMoney()` coerce absent values to 0, which is exactly the
 * bug B2 exists to remove for dashboard health counters; this type makes the
 * distinction impossible to skip at a render site.
 */
export type Maybe<T> = { known: true; value: T } | { known: false };

export function maybeNumber(value: unknown): Maybe<number> {
  if (value === null || value === undefined) return { known: false };
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isNaN(parsed) ? { known: false } : { known: true, value: parsed };
}

export function renderMaybe<T>(maybe: Maybe<T>, fmt: (value: T) => string): string {
  return maybe.known ? fmt(maybe.value) : "—";
}

export const maybeMoney = (value: unknown) => renderMaybe(maybeNumber(value), formatMoney);
