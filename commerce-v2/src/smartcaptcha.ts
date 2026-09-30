export async function verifySmartCaptcha(
  token: string,
  ip: string | undefined,
  secret: string,
  request: typeof fetch = fetch,
) {
  if (!token.trim()) return false;
  const body = new URLSearchParams({ secret, token, ...(ip ? { ip } : {}) });
  const response = await request("https://smartcaptcha.cloud.yandex.ru/validate", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`SMARTCAPTCHA_HTTP_${response.status}`);
  const result = await response.json() as { status?: unknown };
  return result.status === "ok";
}
