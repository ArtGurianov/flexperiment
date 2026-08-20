import { createPublicKey, verify } from "node:crypto";

const JWK_URL = "https://enter.tochka.com/doc/openapi/static/keys/public";
type Jwk = JsonWebKey & { kty: "RSA"; n: string; e: string };

const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;

export class TochkaWebhookVerifier {
  private key: Jwk | undefined;
  private validUntil = 0;
  constructor(readonly request: typeof fetch = fetch, readonly nowMillis = () => Date.now()) {}

  private async load(force = false) {
    if (!force && this.key && this.validUntil > this.nowMillis()) return this.key;
    const response = await this.request(JWK_URL, { headers: { Accept: "application/json" } });
    const key = await response.json().catch(() => undefined) as Jwk | undefined;
    if (!response.ok || !key || key.kty !== "RSA" || !key.n || !key.e) throw new Error("Tochka public JWK is unavailable.");
    this.key = key; this.validUntil = this.nowMillis() + 6 * 60 * 60_000;
    return key;
  }

  private check(jwt: string, key: Jwk) {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("Malformed Tochka webhook JWT.");
    const header = decode(parts[0]);
    if (header.alg !== "RS256") throw new Error("Unexpected Tochka webhook JWT algorithm.");
    if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: { ...key }, format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new Error("Invalid Tochka webhook signature.");
    return decode(parts[1]);
  }

  async verify(jwt: string) {
    try { return this.check(jwt, await this.load()); }
    catch (firstError) {
      try { return this.check(jwt, await this.load(true)); }
      catch { throw firstError; }
    }
  }
}

export const webhookAmountKopecks = (value: unknown) => {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Invalid Tochka webhook amount.");
  const [rubles, fractional = ""] = value.split(".");
  const result = Number(rubles) * 100 + Number(fractional.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new Error("Tochka webhook amount exceeds safe integer range.");
  return result;
};
