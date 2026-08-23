# Metrika consent cutover checklist

The public frontend loads Yandex Metrika counter `111866892` only after the
visitor stores `fx_consent=v1:a1`. Its public counter ID is source-bound in
the consent-gated client manager; it is not a credential and cannot cause a
network request before the consent gate opens.

This repository has no Dockerfile or static-server configuration for the
public `flexperiment.ru` resource: `deploy/Caddyfile` is explicitly a routing
reference, while `Dockerfile.admin` serves only Admin. A runtime-only container
variable cannot change an already exported bundle; the counter ID is already
compiled into the public-site source.
The minimum Phase 13 CSP baseline for this privacy-minimal tag is:

```text
script-src 'self' 'unsafe-inline' https://mc.yandex.ru https://yastatic.net
connect-src 'self' https://api.flexperiment.ru https://mc.yandex.ru
img-src 'self' data: https://flexperiment.s3.cloud.ru https://mc.yandex.ru
frame-ancestors 'none'
```

Yandex notes that CSP examples may not list every endpoint required by Metrika.
Do not preemptively add broad Yandex origins or Webvisor frame/blob allowances;
the controlled browser network smoke is authoritative for any additional,
documented endpoint required by the configured counter.

Before production cutover, verify in the Yandex Metrika UI:

- the counter belongs to `flexperiment.ru` and has no unintended domains;
- Webvisor is disabled;
- “Do not store full IP addresses of site visitors” (IP masking) is enabled;
- no Yandex Tag Manager or other analytics tag bypasses `fx_consent`.

Browser smoke:

1. In a fresh browser, load the public site and confirm no request reaches
   `mc.yandex.ru` before a choice or after “Только необходимые”.
2. Grant analytics and confirm the tag is requested only then.
3. Revoke analytics, navigate to another public page, and confirm no new
   Metrika hit is sent.
4. Confirm `/ticket` and `/refund/confirm` send no analytics request, including
   when their fragment contains a capability.
5. Inspect exported HTML: it must contain neither a Metrika `<script>` nor a
   Yandex noscript beacon. A tag URL in a JavaScript bundle is expected.
