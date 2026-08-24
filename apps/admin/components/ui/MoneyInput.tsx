"use client";

import { formatRubles, parseRublesToKopecks } from "../../../../lib/money";

export function MoneyInput({ value, onChange, maxKopecks, required = false }: {
  value: string;
  onChange: (value: string) => void;
  maxKopecks?: number;
  required?: boolean;
}) {
  const kopecks = parseRublesToKopecks(value);
  const invalid = value !== "" && (kopecks === null || kopecks <= 0 || (maxKopecks !== undefined && kopecks > maxKopecks));
  const message = kopecks === null
    ? "Введите сумму с точностью до копейки."
    : maxKopecks !== undefined && kopecks > maxKopecks
      ? `Доступно не больше ${formatRubles(maxKopecks)}.`
      : null;

  return (
    <>
      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid || undefined}
        required={required}
        placeholder="0,00"
      />
      {kopecks !== null && <small>= {formatRubles(kopecks)}</small>}
      {message && <small className="notice notice-error">{message}</small>}
    </>
  );
}
