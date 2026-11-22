# FLEX-120 /sign-in — local browser evidence

Local, isolated proof of the my sign-in UI. **Not** acceptance in an admitted environment: no real mail,
no real SmartCaptcha keys, no real Commerce behind the proxy.

- Build: `apps/my` standalone (`next build`, Next 16.3.3) from source commit `92fbf005` plus the
  `app/styles.css` form rules in the same commit as this file.
- Runtime: `MY_ORIGIN=http://127.0.0.1:3997`, `COMMERCE_INTERNAL_ORIGIN` pointed at `fake-commerce.mjs`,
  which answers only `/v1/my/legal`, `/v1/my/otp/send`, `/v1/my/otp/verify` (code `123456`) and
  `/v1/my/consents`, and logs what reached it through the real my proxy.
- Driver: `sign-in-playwright.mjs` (Chromium via Playwright, 420×820 @2x). Output: `run.log`.

| Step | Screenshot | Checked |
| --- | --- | --- |
| E-mail + separate consents | `01-email.png` | "Получить код" stays disabled until both required boxes are ticked; marketing is optional and unticked |
| Code step | `02-code.png` | generic "if sign-in is possible" text, 60 s resend cooldown |
| Wrong code | `03-wrong-code.png` | `OTP_INVALID_OR_EXPIRED` shown as a retry path (the one console 400 is this expected answer) |
| Success | `04-orders.png` | after verify, the form posts the exact choices to `/v1/my/consents` and only then leaves for `next=/orders` |

`run.log` also records the response headers of `/sign-in`: `Referrer-Policy: no-referrer` and a CSP with
`form-action 'self' https://flexperiment.ru`, `frame-ancestors 'none'` and SmartCaptcha
(`https://smartcaptcha.cloud.yandex.ru`) as the only third-party origin. It also records each upstream call
with `x-forwarded-host` set by the proxy and e-mail, code and action key redacted.

Server-side behaviour (real Better Auth 1.7.6, SQLite and the Commerce app) is covered by
`commerce-v2/test/my-identity-otp.test.ts`.
