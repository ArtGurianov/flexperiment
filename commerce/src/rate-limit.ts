import { DomainError } from "./domain";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, max: number, windowMs: number) {
  const timestamp = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= timestamp) {
    buckets.set(key, { count: 1, resetAt: timestamp + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > max) {
    const retryAfter = Math.ceil((bucket.resetAt - timestamp) / 1_000);
    throw new DomainError("RATE_LIMITED", 429, String(retryAfter));
  }
}

export function clientIp(headers: Headers) {
  // A reverse proxy must set this header after stripping the client-supplied one.
  return headers.get("x-commerce-trusted-client-ip") ?? "unknown";
}
