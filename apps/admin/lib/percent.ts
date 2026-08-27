/** Parses a Russian decimal percentage without floating point multiplication. */
export function parsePercentToBasisPoints(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const result = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(result) ? result : null;
}

export function formatBasisPoints(value: number): string {
  return `${Math.floor(value / 100)},${String(value % 100).padStart(2, "0")}%`;
}
