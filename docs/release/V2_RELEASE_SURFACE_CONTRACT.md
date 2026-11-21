# V2 release surface contract — Stage A (Commerce V2, Platform, Admin V2)

2026-11-21 · E · база `main` `be55bb7`. `release-surface-contract.json` в корне — контракт V1
(читают `commerce/src/write-static-release-descriptor.ts` и `apps/admin/scripts/write-release-descriptor.mjs`);
его не меняем и V2 к нему не привязываем.

## Поверхности

| Поверхность | Dockerfile | Identity | service |
| --- | --- | --- | --- |
| Commerce V2 | `Dockerfile.commerce-v2` | `GET /identity` (`commerce-v2/src/app.ts:255`) | `commerce-v2` |
| Platform | `Dockerfile.platform` | `GET /identity` (`apps/platform/app/identity/route.ts`) | `platform` |
| Admin V2 | `Dockerfile.frontends-v2`, `V2_FRONTEND_SERVICE=admin-v2` | `GET /identity` (nginx alias `/app/.identity/identity.json`) | `admin-v2` |

Документ identity: `{"schema":"flexperiment.build-identity/1","service":…,"sourceCommit":<40-hex>}`,
вшит при сборке из `SOURCE_COMMIT`. Наблюдение — `production-runtime-identity-readout.yml`
(`deploy/release/read-v2-identity.sh`). Наблюдение не является авторитетом деплоя.

## Правила

1. **Один кандидат — один commit** для всех трёх поверхностей; CI `test` и `docker-build` зелёные на нём.
2. **Commerce V2 и Admin V2**: образ не зависит от окружения; допускается один и тот же digest на canary и production.
3. **Platform собирается на окружение.** `PLATFORM_ORIGIN` — build ARG (`Dockerfile.platform`, по умолчанию
   `https://flexperiment.ru`; F · #290): `/` и `/courses` пререндерятся при сборке с canonical/og:url из него.
   Поэтому для Platform: тот же commit, **разные** сборки и digest на canary и production. Перенос digest
   canary в production запрещён. Проверка — canonical/og:url на каждом окружении (A-6.4).
4. **Digest** читается на хосте (`docker inspect`, read-only, GO D-07) и сопоставляется с deployment Coolify;
   CI образы не публикует (`push: false`) — G-12/D-06.
5. **Флаги окружения, требующие решения владельца:** `PAYMENT_MODE` (Stage A — `disabled`, `mock` в production
   отклоняется), `INDEXNOW_ENABLED` (только `true` при `DEPLOY_ENV=production`, включение — D-11),
   `MARKETING_BROADCASTS_ENABLED=false` (FLEX-38).
6. CI-шаги, которые E отслеживает: `docker-build` (все Dockerfile), «Recovery backup contract»,
   «V2 identity readout contract», `seo-audit-ci.sh` F (после `pnpm platform:build`, `PLATFORM_ORIGIN=https://build.invalid`,
   loopback, 3 мин).
