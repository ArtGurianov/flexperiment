/** Exact, non-negative half-up arithmetic for basis-point amounts. */
export function basisPointsOf(amount: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError("Basis-point operands must be non-negative safe integers.");
  }
  const result = (BigInt(amount) * BigInt(basisPoints) + BigInt(5_000)) / BigInt(10_000);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Basis-point result exceeds the safe integer range.");
  return Number(result);
}
