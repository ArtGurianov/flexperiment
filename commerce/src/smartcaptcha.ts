const VALIDATE_URL = "https://smartcaptcha.cloud.yandex.ru/validate";

export type SmartCaptchaResult = "PASS" | "INVALID" | "UNAVAILABLE";

export interface SmartCaptchaVerifier {
  verify(token: string, clientIp?: string): Promise<SmartCaptchaResult>;
}

/** Fails closed until the runtime has been given the private server key. */
export class UnconfiguredSmartCaptchaVerifier implements SmartCaptchaVerifier {
  async verify(): Promise<SmartCaptchaResult> { return "UNAVAILABLE"; }
}

export class YandexSmartCaptchaVerifier implements SmartCaptchaVerifier {
  constructor(
    private readonly serverKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async verify(token: string, clientIp?: string): Promise<SmartCaptchaResult> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 3_000);
    try {
      const body = new URLSearchParams({ secret: this.serverKey, token });
      if (clientIp) body.set("ip", clientIp);
      const response = await this.request(VALIDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: abort.signal,
      });
      if (!response.ok) return "UNAVAILABLE";
      const payload = await response.json().catch(() => null) as { status?: unknown } | null;
      return payload?.status === "ok" ? "PASS" : "INVALID";
    } catch {
      // Deliberately do not include provider text, token, or secret in logs or
      // the public API. A failed verification cannot authorize a mutation.
      return "UNAVAILABLE";
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const smartCaptchaVerifierFromEnvironment = (environment = process.env): SmartCaptchaVerifier => {
  const serverKey = environment.YANDEX_SMARTCAPTCHA_SERVER_KEY?.trim();
  return serverKey ? new YandexSmartCaptchaVerifier(serverKey) : new UnconfiguredSmartCaptchaVerifier();
};
