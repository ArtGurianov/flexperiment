# FLEX-104 (ART-340) — read-only инвентаризация остатков Payload

2026-11-21 · база `main` `be55bb755100535fd2af5f2a407b1be0199e2c40` · исполнитель E.
**Только чтение репозитория.** Хост, Coolify, бакеты и env не читались: для этого нужен owner GO
(D-07 пакета Stage A). Ничего не удалено и не изменено. Удаление runtime-ресурсов — отдельный GO
после `CLOSED_LMS_E2E_PASS` и owner retention verdict (условия карточки).

## 1. Исходники — состояние

| Объект | Находка | Вывод |
| --- | --- | --- |
| `apps/platform` runtime | Нет `payload.config`, `withPayload`, `@payloadcms/*` (в `pnpm-lock.yaml` 0 совпадений) | Runtime Platform без Payload |
| `apps/platform/lib/canary-config.ts:11,24` | Допускает конфигурацию только при **отсутствии** `PAYLOAD_DATABASE_URL`, `PAYLOAD_SECRET`, `PAYLOAD_JOBS_ENABLED` | Негативный предохранитель — оставить |
| `apps/platform/test/{local-api-boundary,canary-proxy,…}.test.ts` | Проверяют отсутствие Payload | Оставить (карточка: тесты доступа/erasure/SEO сохраняются) |
| `.github/workflows/test.yml:118,206,268,298` | «Payload-free platform» сборка и smoke | Оставить |
| `scripts/ci/smoke-platform-canary.py:72-73` | Проверяет, что в образе нет `payload.config.ts`, `migrations`, `node_modules/payload` | Оставить |
| `README.md:22` | «Payload is retired» | Верно |
| `.env.example:56,89` | Всё ещё перечисляет `PAYLOAD_DATABASE_URL`, `PAYLOAD_SECRET` | **Устаревшее; кандидат на удаление** (файл вне зоны E — через координатора) |

## 2. Остатки канарейки Platform (editorial SQLite) — требуют решения

| Объект | Что делает | Зависимость |
| --- | --- | --- |
| `scripts/v2/platform-backup.py:45-47,76` | Резервирует Payload SQLite (`payload_migrations`, `users`, `courses`, `lessons`) из `/var/lib/flexperiment-platform-canary/platform.sqlite` | Требует `PAYLOAD_DATABASE_URL` |
| `scripts/v2/platform-scheduled-backup.py:43-45` | Плановый backup/check той же БД | env Payload в unit |
| `deploy/v2/platform-canary-backup.{service,timer}` | Запуск backup | хост `/usr/local/lib/flexperiment-v2/` |
| `deploy/v2/platform-canary-backup-freshness.{service,timer}`, `canary-alert-platform-*.conf` | Алерт свежести | Удалять **только после** подтверждения, что Commerce backup покрывает editorial content (миграция 0026) и нет alert gap |
| `/var/lib/flexperiment-platform-canary-backups` (по docs/plans) | Архивы editorial БД | Хранить по owner policy; не удалять без verdict |

## 3. Read-only проверка хоста (выполнять только по GO D-07)

Команды только читают; вывод — без значений env и без содержимого БД:

```sh
systemctl list-timers 'platform-canary-backup*' --all --no-pager
systemctl is-enabled platform-canary-backup.timer platform-canary-backup-freshness.timer
ls -la /var/lib/flexperiment-platform-canary/ /var/lib/flexperiment-platform-canary-backups/ | head
# Coolify: только ИМЕНА переменных Platform-ресурса, сравнить с PAYLOAD_*/PLATFORM_COMMERCE_SERVICE_TOKEN
# Docker: docker inspect <platform> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Ожидание для Stage A: в live Platform нет `PAYLOAD_*`, нет тома editorial SQLite, нет второй
авторской сессии. Любая находка → отдельное решение владельца, не исправление на месте.

## 4. Влияние на Stage A (для аудита FLEX-16)

| Часть вывода Payload | Влияет на Stage A? | Почему |
| --- | --- | --- |
| Runtime Platform без Payload (исходники, образ, CI smoke) | **Да, условие допуска — уже выполнено в исходниках** | FLEX-16: «No Payload»; подтверждается в развёрнутом образе только A-6 (identity) + п. 3 |
| Отсутствие `PAYLOAD_*` в live env Platform, нет тома editorial SQLite | **Да — не проверено** | Нужна read-only проверка хоста (п. 3, GO D-07); при находке — решение владельца |
| `platform-canary-backup*` таймеры и freshness-алерты | **Нет напрямую** | Касаются канареечной editorial БД; не являются источником данных Stage A. Риск — ложные алерты/alert gap, не допуск |
| Архивы editorial БД | **Нет** | Хранятся по owner policy; Commerce backup (0026) — источник контента Stage A |
| `.env.example` `PAYLOAD_*` | **Нет** | Документация; риск ошибочной настройки |

## 5. Что требует отдельного разрешения

| Действие | Разрешение |
| --- | --- |
| Read-only проверка хоста/Coolify/томов (п. 3) | owner GO D-07 |
| Выключение/удаление `platform-canary-backup*` units и drop-ins | owner GO на хост после `CLOSED_LMS_E2E_PASS`; CUSTODY_IMPACT: YES |
| Удаление тома/архивов editorial SQLite, Coolify env/shared secrets | owner retention verdict + отдельный GO |
| Правка `.env.example` | координатор (вне зоны E), без хоста |
| Правка `deploy/**`, `scripts/v2/platform-*backup*` в репозитории | PR E, merge — владелец; не меняет хост сам по себе |

## 6. Предложения (не выполнены)

1. `.env.example`: убрать `PAYLOAD_*` — координатору (файл вне зоны E).
2. После `CLOSED_LMS_E2E_PASS` и verdict: выключение `platform-canary-backup*` — отдельный PR E
   (`deploy/**`) + owner GO на хост; CUSTODY_IMPACT: YES (systemd units, backup path).
3. Карточка FLEX-104 остаётся в Backlog: этот документ — инвентаризация, не выполнение.
