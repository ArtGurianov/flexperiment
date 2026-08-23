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

The API sends the token and, only when it can safely resolve one, the client IP
to `https://smartcaptcha.cloud.yandex.ru/validate` as form data. Tokens are
never stored or logged. Missing configuration, timeout, malformed response,
and non-2xx validation responses fail closed as `CAPTCHA_UNAVAILABLE`; an
invalid or expired token is `CAPTCHA_INVALID`.

## Trusted client IP boundary

Production has exactly one trusted ingress boundary:

```text
Internet -> Coolify Traefik -> commerce:3001
```

Commerce reads the standard `X-Forwarded-For` header. With Traefik forwarded
headers at their safe defaults (no `forwardedHeaders.insecure` and no
`trustedIPs`), Traefik removes forwarded headers received from an untrusted
internet peer and appends that peer address before proxying. Commerce therefore
accepts only one trimmed IPv4 or IPv6 literal. A missing, malformed, host:port,
or comma-separated value is not a trusted client address: SmartCaptcha still
receives `secret` and `token`, but no `ip` parameter.

This application check cannot protect a directly reachable Commerce container:
the network boundary is part of the security invariant. `commerce:3001` must
remain internal-only (`expose`, never a host `ports` publish), and Traefik and
Commerce must share the private Docker network. If a CDN, Cloudflare, load
balancer, or another reverse proxy is inserted before Traefik, review and
explicitly reconfigure this trust model before production use. See Traefik's
[forwarded-header documentation](https://doc.traefik.io/traefik/routing/entrypoints/).

### Controlled production verification

Do this during a controlled window using only `GET /v1/public/tour`, so no
CAPTCHA token, cookie, or request body is captured. Use a temporary,
access-controlled packet/header observation on the Commerce Docker network;
do not add a permanent diagnostic route or log request headers.

1. From a real external client, call the public API and confirm Commerce sees
   one `X-Forwarded-For` value equal to that client's public address.
2. Repeat from an external client with `X-Forwarded-For: 1.2.3.4`; confirm the
   observed Commerce value is the real source address, never `1.2.3.4`.
3. Stop the temporary observation and retain no packet/header output beyond
   the minimal pass/fail evidence, because source addresses are personal data.
4. Confirm the deployed Traefik is at least v3.6.14 (the fixed v3.6 release
   for forwarded-header alias spoofing) and retain the effective
   forwarded-header configuration with the release evidence.

### Production trusted-IP verification — 2026-08-23

The controlled verification passed on the actual production Docker bridge:

```text
Internet -> Coolify Traefik 3.6.25 -> commerce:3001
```

- A normal external request reached Commerce with exactly one
  `X-Forwarded-For` value.
- `X-Real-Ip` matched that `X-Forwarded-For` value.
- A forged client `X-Forwarded-For: 1.2.3.4` was stripped by Traefik, so
  Commerce received only the real public client address.
- Commerce had no published host port and was reached through the Docker
  network.

This verifies the current `trustedClientIp()` contract for this topology:
accept exactly one valid IPv4/IPv6 literal from `X-Forwarded-For`, reject
chains and malformed values, and omit SmartCaptcha's `ip` when no trusted
address is available. Traefik must remain at least v3.6.14; production is
currently verified on 3.6.25. Re-run this review before placing a CDN or any
other reverse proxy ahead of Traefik.

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
