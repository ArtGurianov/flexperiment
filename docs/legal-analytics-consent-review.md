# Legal review note: analytics-consent evidence

The Phase 13 technical gate keeps Yandex Metrika disabled until the browser
stores the first-party preference `fx_consent=v1:a1`; `v1:a0` keeps it
disabled. The preference is currently client-side only.

Under Article 9 of Federal Law No. 152-FZ, the operator bears the burden of
proving that consent was obtained. Before publishing legal release
`2026-08-22.1`, legal and Roskomnadzor review must decide whether this
client-side preference plus the deterministic no-`a1`/no-Metrika gate is
sufficient evidence, or whether a durable CMP/consent receipt is required.

This is a review decision, not an implementation of an analytics-consent
ledger. It does not change the checkout personal-data consent or the legal
release schema.
