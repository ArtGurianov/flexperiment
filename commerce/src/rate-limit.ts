import { isIP } from "node:net";
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

/**
 * Resolves the client address only for the current production boundary:
 * Internet -> one Coolify Traefik ingress -> Commerce.
 *
 * With Traefik's forwarded headers left at their safe defaults, Traefik drops
 * client-supplied forwarded headers and appends the direct peer address to
 * `X-Forwarded-For`. Commerce therefore expects exactly one IP literal. A
 * chain means the deployment assumption is no longer true, so it is not a
 * trustworthy client identity for CAPTCHA or rate limiting.
 */
export function trustedClientIp(headers: Headers): string | undefined {
  const forwardedFor = headers.get("X-Forwarded-For");
  if (!forwardedFor) return undefined;

  const parts = forwardedFor.split(",");
  if (parts.length !== 1) return undefined;

  const candidate = parts[0]?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

export const UNTRUSTED_CLIENT_IP_BUCKET = "untrusted-ingress";

/**
 * A missing trustworthy IP shares a deliberately conservative, endpoint-
 * scoped bucket. This keeps the IP limits enforced without treating the
 * string "unknown" as an address; sensitive endpoints retain their existing
 * email/order/token limits as a second anti-abuse boundary.
 */
export function clientIpRateLimitKey(scope: string, headers: Headers): string {
  return `${scope}:${trustedClientIp(headers) ?? UNTRUSTED_CLIENT_IP_BUCKET}`;
}
