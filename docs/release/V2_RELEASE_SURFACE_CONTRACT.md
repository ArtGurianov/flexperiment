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

## Custody-ресурсы V2 (создание и изменение — только по OWNER GO, CUSTODY_IMPACT: YES)

| Ресурс | Владелец кода | Где хранится | Восстановление | Статус |
| --- | --- | --- | --- | --- |
| `labTicketQrSecret` — ключ QR билета аккаунт-заказа LAB (D · #292) | D | Coolify env Commerce V2; копия — SOPS host credential / encrypted external bundle (по `adman-vps-infrastructure`) | Восстанавливается из custody, **не** генерируется заново: смена ключа делает выданные QR недействительными (ротация — только через `qr_generation`, отдельным решением) | **Отложен решением владельца (Q-QR, v4.8, 22.11):** постоянный секрет не создаётся; тесты D — на синтетическом ключе. Возобновление — новое решение владельца, затем OWNER GO, issue в инфраструктурном проекте и `CUSTODY_PENDING` до свежего capture |
| `KINESCOPE_DRM_TOKEN_KEYS` (существует) | A | Coolify env Commerce V2 | Не восстанавливается, а перевыпускается (docs/kinescope-playback-signing.md) | Без изменений |
| `PLATFORM_ORIGIN` build ARG на ресурс Platform (G-17) | E/F | Coolify build config | Конфигурация, не секрет | Задать по GO D-07 |

DDL D: `ALTER TABLE lab_tickets ADD qr_generation` — регистрируется у координатора до интеграции; оба fingerprint
(retention, erasure) и restore-сценарий для итоговой схемы.
