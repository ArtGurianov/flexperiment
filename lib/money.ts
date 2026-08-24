/**
 * The one sanctioned rubles<->kopecks conversion. Rubles are the UI
 * representation; kopecks are the domain/transport representation.
 * Conversion is exact decimal string parsing, never float arithmetic —
 * `Math.round(Number(x) * 100)` mis-rounds (`1.005 * 100 === 100.4999…`)
 * and doesn't handle the Russian comma decimal separator.
 */

export function formatRubles(kopecks: number): string {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopecks / 100);
}

/**
 * Strips whitespace thousand separators (including the NBSP
 * Intl.NumberFormat itself uses), accepts one "," or "." decimal separator,
 * rejects more than 2 fractional digits rather than silently rounding an
 * operator's typo, and does the whole conversion with integer arithmetic.
 * Returns null for anything that isn't an unambiguous, exact non-negative
 * ruble amount.
 */
export function parseRublesToKopecks(input: string): number | null {
  const trimmed = input.replace(/\s/g, "");
  if (!trimmed) return null;
  const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const [, sign, whole, frac] = match;
  if (sign) return null;
  const kopecks = Number(whole) * 100 + Number((frac ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(kopecks) ? kopecks : null;
}
