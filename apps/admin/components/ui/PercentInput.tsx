"use client";

import { useId } from "react";
import { formatBasisPoints, parsePercentToBasisPoints } from "../../lib/percent";

export function PercentInput({ value, onChange, minBasisPoints, maxBasisPoints }: {
  value: string;
  onChange: (value: string) => void;
  minBasisPoints: number;
  maxBasisPoints?: number;
  required?: boolean;
}) {
  const helpId = useId();
  const basisPoints = parsePercentToBasisPoints(value);
  const valid = basisPoints !== null && basisPoints >= minBasisPoints && (maxBasisPoints === undefined || basisPoints <= maxBasisPoints);
  const message = !value ? "Укажите процент." : basisPoints === null ? "Введите процент с точностью до двух знаков, например 10,00%." : !valid
    ? maxBasisPoints === undefined ? "Процент не может быть отрицательным." : `Допустимо от ${formatBasisPoints(minBasisPoints)} до ${formatBasisPoints(maxBasisPoints)}.`
    : null;
  return <>
    <input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={value !== "" && !valid} aria-describedby={helpId} required />
    {valid ? <small id={helpId}>= {formatBasisPoints(basisPoints)}</small> : <small id={helpId} className="notice notice-error">{message}</small>}
  </>;
}
