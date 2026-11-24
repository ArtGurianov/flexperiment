type Environment = Readonly<Record<string, string | undefined>>;
export const CAPTCHA = "https://smartcaptcha.cloud.yandex.ru";

/** The exchange form posts only to the LMS origin (contract §6); nothing frames my. */
export function securityHeaders(environment: Environment = process.env) {
  const platform = environment.PLATFORM_ORIGIN?.trim() || "http://localhost:3001";
  const csp = [
    "default-src 'self'",
    // Next.js hydration needs inline bootstrap scripts; a nonce-based policy can replace this later.
    // Yandex SmartCaptcha is the only third-party origin (FLEX-120 sign-in), nothing else loads.
    `script-src 'self' 'unsafe-inline' ${CAPTCHA}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${CAPTCHA}`,
    `connect-src 'self' ${CAPTCHA}`,
    `frame-src ${CAPTCHA}`,
    `form-action 'self' ${new URL(platform).origin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cache-Control", value: "no-store" },
  ];
}
