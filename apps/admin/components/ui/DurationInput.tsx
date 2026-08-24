"use client";

import { formatDuration, parseHoursAndMinutes } from "../../lib/duration";

export function DurationInput({ value, onChange, required = false, minMinutes = 1 }: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  minMinutes?: number;
}) {
  const minutes = parseHoursAndMinutes(value);
  const invalid = value !== "" && (minutes === null || minutes < minMinutes);
  const message = minutes === null
    ? "Введите часы и минуты, например 1,30."
    : minutes < minMinutes
      ? "Значение должно быть больше нуля."
      : null;

  return (
    <>
      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid || undefined}
        required={required}
        placeholder="1,30"
      />
      {minutes !== null && <small>= {formatDuration(minutes)}</small>}
      {message && <small className="notice notice-error">{message}</small>}
    </>
  );
}
