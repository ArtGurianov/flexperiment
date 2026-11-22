# FLEX-122 checkout smoke (local, fixtures only)

A scripted Commerce (`fake-commerce.mjs`) behind the real `apps/my` proxy (`/v1/*`). It has no
provider and moves no money. The fake "provider" returns straight to `/checkout/<id>?order=`.
`run.mjs` drives Chromium through the LMS and LAB scenarios. The result is in `checkout-smoke.log`.

```sh
pnpm --filter @flexperiment/my build
MY_ORIGIN=http://localhost:3003 node test/smoke/fake-commerce.mjs "$PWD/test/fixtures/checkout/commerce-answers.json" &
MY_ORIGIN=http://localhost:3003 COMMERCE_INTERNAL_ORIGIN=http://127.0.0.1:4999 PLATFORM_ORIGIN=http://localhost:3001 pnpm start &
PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.js" node test/smoke/run.mjs /tmp/shots
```

This proves the UI and proxy wiring on fixtures. It is not acceptance against a real Commerce. That
needs R1–R4 (C/D) and an admitted environment.
