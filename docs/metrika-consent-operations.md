# Metrika consent cutover checklist

The public frontend loads Yandex Metrika only after the visitor stores
`fx_consent=v1:a1`. The counter ID is the public build-time variable
`NEXT_PUBLIC_YANDEX_METRIKA_ID`; an absent or invalid value fails closed.

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
