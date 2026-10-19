import { describe, expect, it } from "vitest";
import { labGuestClientIp, labGuestTrustedProxyIps } from "../src/lab-guest-client-ip";

describe("LAB trusted request source", () => {
  it("trusts only an exact socket peer plus one canonical replacement address", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.1", "x-forwarded-for": "192.0.2.1", "cf-connecting-ip": "192.0.2.2", forwarded: "for=192.0.2.3" });
    expect(labGuestClientIp(headers, "::ffff:10.0.5.4", ["10.0.5.4"])).toBe("203.0.113.1");
    expect(labGuestClientIp(headers, "10.0.5.99", ["10.0.5.4"])).toBeUndefined();
    expect(labGuestClientIp(headers, "10.0.5.4", [])).toBeUndefined();
    for (const value of ["192.0.2.1, 192.0.2.2", "192.0.2.1:443", "192.0.2.1/24", "fe80::1%eth0", "not-an-ip"]) {
      headers.set("x-real-ip", value); expect(labGuestClientIp(headers, "10.0.5.4", ["10.0.5.4"])).toBeUndefined();
    }
    headers.delete("x-real-ip"); expect(labGuestClientIp(headers, "10.0.5.4", ["10.0.5.4"])).toBeUndefined();
  });
  it("canonicalizes IPv6 and rejects CIDR/subnet/port configuration", () => {
    expect(labGuestTrustedProxyIps("10.0.5.4, ::ffff:10.0.5.5, 2001:0db8::1")).toEqual(["10.0.5.4", "10.0.5.5", "2001:db8::1"]);
    expect(labGuestTrustedProxyIps(undefined)).toEqual([]);
    for (const value of ["10.0.5.0/24", "0.0.0.0/0", "10.0.5.4:80", "*"]) {
      expect(() => labGuestTrustedProxyIps(value)).toThrow("LAB_GUEST_TRUSTED_PROXY_IPS_INVALID");
    }
  });
});
