import { describe, expect, it } from "vitest";
import { YandexSmartCaptchaVerifier } from "../src/smartcaptcha";

describe("Yandex SmartCaptcha verifier", () => {
  it("posts the one-time token and trusted client IP as form data, without accepting malformed replies", async () => {
    let request: Request | undefined;
    const verifier = new YandexSmartCaptchaVerifier("ysc2_secret", async (input, init) => {
      request = new Request(input, init);
      return Response.json({ status: "ok", host: "flexperiment.ru" });
    });
    await expect(verifier.verify("one-time-token", "198.51.100.10")).resolves.toBe("PASS");
    expect(request?.url).toBe("https://smartcaptcha.cloud.yandex.ru/validate");
    expect(request?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(await request?.text()).toContain("token=one-time-token");
    expect(await new YandexSmartCaptchaVerifier("ysc2_secret", async () => Response.json({ status: "failed" })).verify("expired", "198.51.100.10")).toBe("INVALID");
    expect(await new YandexSmartCaptchaVerifier("ysc2_secret", async () => new Response("bad", { status: 500 })).verify("token", "198.51.100.10")).toBe("UNAVAILABLE");
  });
});
