# Yandex SmartCaptcha operations

`POST /v1/public/city-interest` and `POST /v1/public/refunds/request` require a
one-time Yandex SmartCaptcha proof before any stateful work. The browser loads
the widget only while one of those forms is visible; it is a functional
anti-abuse dependency and is independent of `fx_consent` / Yandex Metrika.

## Coolify configuration

- Static site build environment: `NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY`
  (`ysc1_…`, public client key).
- Commerce API environment: `YANDEX_SMARTCAPTCHA_SERVER_KEY` (`ysc2_…`,
  private server key). Do not set this in the static-site resource or use a
  `NEXT_PUBLIC_` name.

The API sends the token and trusted proxy client IP to
`https://smartcaptcha.cloud.yandex.ru/validate` as form data. Tokens are never
stored or logged. Missing configuration, timeout, malformed response, and
non-2xx validation responses fail closed as `CAPTCHA_UNAVAILABLE`; an invalid
or expired token is `CAPTCHA_INVALID`.

## CSP and browser verification

The repository's current Caddy and Admin nginx configs do **not** enforce a
Content-Security-Policy. If a production proxy CSP is introduced, allow only
the SmartCaptcha origins proven by browser Network inspection; begin with
`https://smartcaptcha.cloud.yandex.ru` for `script-src`, `frame-src`, and
`connect-src`, then add a narrowly scoped origin only if the widget requires
it. Do not use wildcard Yandex origins.

Before release, verify in a normal browser that the widget can solve/expire and
reset in both forms, and that it does not load or call `mc.yandex.ru` or create
Metrika traffic without analytics consent. SmartCaptcha may itself make
third-party network requests or set provider storage/cookies; record that
observed behavior in the release evidence.
