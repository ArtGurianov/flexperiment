import { describe, expect, it } from "vitest";
import { clientIpRateLimitKey, trustedClientIp, UNTRUSTED_CLIENT_IP_BUCKET } from "../src/rate-limit";

describe("trustedClientIp", () => {
  it("accepts one Traefik-sanitized IPv4 or IPv6 literal", () => {
    expect(trustedClientIp(new Headers({ "x-forwarded-for": "198.51.100.17" }))).toBe("198.51.100.17");
    expect(trustedClientIp(new Headers({ "X-Forwarded-For": " 2001:db8::1 \t" }))).toBe("2001:db8::1");
  });

  it.each([
    "",
    "   ",
    "not-an-ip",
    "198.51.100.17:443",
    "[2001:db8::1]:443",
    "198.51.100.17, 203.0.113.9",
    ",198.51.100.17",
  ])("rejects an unsafe forwarded-for value %j", (forwardedFor) => {
    expect(trustedClientIp(new Headers({ "X-Forwarded-For": forwardedFor }))).toBeUndefined();
  });

  it("does not select a spoofable element from a forwarded chain", () => {
    // A direct client could send the first value. A multi-value chain is not
    // expected after the sole Traefik ingress has sanitized and appended XFF.
    expect(trustedClientIp(new Headers({ "X-Forwarded-For": "1.2.3.4, 198.51.100.17" }))).toBeUndefined();
  });
});

describe("clientIpRateLimitKey", () => {
  it("uses an endpoint-scoped deterministic fallback when the IP is unavailable", () => {
    const headers = new Headers();
    expect(clientIpRateLimitKey("city-interest-ip", headers)).toBe(`city-interest-ip:${UNTRUSTED_CLIENT_IP_BUCKET}`);
    expect(clientIpRateLimitKey("customer-refund-request-ip", headers)).toBe(`customer-refund-request-ip:${UNTRUSTED_CLIENT_IP_BUCKET}`);
  });
});
