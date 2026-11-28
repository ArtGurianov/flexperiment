# Карта данных просмотра и согласий — Stage A (FLEX-75 / FLEX-128)

Источник: код `main` @ `be55bb755100535fd2af5f2a407b1be0199e2c40`, прочитан 2026-11-20.
Это описание реализации в исходниках, а не доказательство поведения развёрнутой
системы. Подтверждение в допущенной среде — в [плане приёмки](CLOSED_ACCEPTANCE_PLAN.md).

## 1. Хранилища Commerce V2 (SQLite)

| Таблица (миграция) | Поля с ПД / связь | Кто пишет | Удаление по запросу (`erasure-restore.ts:146-153`) | Технический срок (`pd-retention.ts`) | Раздел текста |
| --- | --- | --- | --- | --- | --- |
| `customers`, `"user"`, `account`, `session`, `verification` (0001) | email, auth user id; сессия: IP, user-agent | Better Auth (`auth.ts`), `/v1/auth/*` | Да; сессии удаляются каскадом, `verification` по email | `EXPIRED_CREDENTIALS` — значение не утверждено (D-05) | privacy §2, §5; personal_data §2 |
| `auth_email_outbox` (0001) | email получателя, зашифрованный payload, sha256 | `auth-email-delivery.ts` → NotiSend | Да, по email | `AUTH_OUTBOX` — D-05 | privacy §2 «служебное письмо» |
| `authenticated_consent_actions` / `_events` (0025) | customer_id, auth_user_id, release id/version, manifest sha, document version/sha, выбор | `recordAuthenticatedConsents` (`authenticated-consents.ts`) | Да | Не очищается автоматически (пока аккаунт активен) | personal_data §6; account_terms §2 |
| `account_consents`, `marketing_consents`, `registration intents` (до 0025) | исторические отметки до подтверждения email | устаревший поток | Да | `UNBOUND_INTENTS` — D-05 | account_terms §2 («не считаются согласием») |
| `free_course_enrollments` (0024) | customer_id, product_id/version, `enrolled_at` | запись FREE (A · FLEX-128) | Да | — (пока аккаунт активен) | account_terms §3 |
| **`course_learning_starts` (0037, A · FLEX-128, ещё не в `main`)** | customer_id, курс, дата начала (`startedAt`; у исторических неявных записей `null`, без backfill); прогресс 0% | запись FREE (A) | **Назначено A: добавить в список erasure** (G-01) | **Назначено A: классификация + оба fingerprint** (G-01) | account_terms §3; privacy §2 |
| `course_access_starts` (0004) | customer_id, course_ref, first_lesson_ref, first_accessed_at | платный доступ (возврат). FLEX-128: не менять из клика записи | Да | — | платные условия, не Stage A |
| `lesson_resume_positions` (0001) | customer_id, lesson_ref, seconds, client_seq, client_ts, updated_at; одна строка на урок | `saveResumePosition` (`resume.ts`) ← `/v1/lessons/:ref/resume` (интервал + `sendBeacon`) | Да (и FK cascade) | — (пока аккаунт активен) | privacy §2 «Данные просмотра» |
| `playback_access_events` (0008) | customer_id (без FK), lesson_ref, video_id, event_type, reason, occurred_at | `recordPlaybackAccessEvent` при grant/DRM callback | Да, по customer_id | `PLAYBACK_TELEMETRY` — D-05 | privacy §2, §5 |
| `playback_grant_rate_limits` (0001) | customer_id, окно, счётчик | `playback-auth.ts` | Да | — (окна краткие; очистка не реализована, G-09) | privacy §2 (защита) |
| `notification_campaign_recipients` (до 0025) | email/customer, статус | рассылки (выключены) | Да | — | marketing_consent |
| `legal_releases` (0001) | без ПД | `activateLegalRelease` | — | — | — |
| независимый erasure ledger / fence (ART-351) | хеши субъекта, отдельная БД | `erasure-ledger.ts`, `erasure-fence.ts` | — (это и есть журнал удалений) | хранится отдельно | privacy §5 (восстановление) |

Резервная копия: `deploy/host/flexperiment-commerce-v2-backup@.{service,timer}` → зашифрованные копии
в Cloud.ru Object Storage; срок копии `BACKUP_ARCHIVES` — D-05. Восстановление применяет ledger
до открытия (`erasure-restore.ts`, `restore-reconciliation.ts`).

## 2. Потоки к внешним получателям

| Поток | Что уходит | Из кода | Получатель |
| --- | --- | --- | --- |
| Ссылка входа | email, письмо со ссылкой | `auth-email-delivery.ts` (NOTISEND) | ООО «НотиСенд» |
| Проверка запроса ссылки | токен SmartCaptcha, IP (если надёжно определён) | `smartcaptcha.ts`, `app.ts:726-729`; виджет `AccountClient.tsx` | ООО «Яндекс.Облако» (Yandex SmartCaptcha) |
| Встраивание плеера | `videoId`, `drmauthtoken` (iss, sub=customer id, vid, exp, jti, kid; без email) | `LessonPlayer.tsx:20-27`, `iframeApi.ts` (`player.kinescope.io`) | ООО «Кинескоп» (браузер → Kinescope напрямую) |
| DRM license callback | токен обратно в Commerce `/v1/kinescope/drm/authorize` | `playback-auth.ts` | Kinescope → Commerce |
| Резервная копия | зашифрованный файл БД | `deploy/host/*backup*` | Cloud.ru |
| Аналитика | только после `fx_consent=v1:a1` | `components/analytics/AnalyticsConsent.tsx` | Яндекс Метрика (F · FLEX-70; G-08) |

## 3. Согласия: модель и привязка к редакции

- Обязательные для доступа: `personal_data` и `account_terms` активного релиза витрины COURSES
  (`hasRequiredAccountConsents`). `marketing_consent` — необязательный выбор.
- Событие валидно только для точного `legal_release_id`, `release_version`, `manifest_sha256`,
  `document_version`, `document_sha256` и подтверждённого email. Любая смена активного релиза
  делает все прежние согласия недостаточными → нужна повторная отметка (account_terms §8).
- Сейчас (по `publication-record.json` review.5) для COURSES активен закрытый Stage B релиз
  `2026-10-16.closed-paid-test.review.5`. Активация Stage A заменит его (см. D-02).
- Время события берётся из `authenticated_consent_actions.recorded_at`; источник действия —
  storefront + action_key; отдельного поля IP в событии согласия нет (тексты IP в событии не обещают).

## 4. Соответствие текста и реализации — проверено чтением кода

| Утверждение в candidate.2 | Код | Статус |
| --- | --- | --- |
| Ссылка входа 10 минут, хранится хеш | `auth.ts:86` `expiresIn: 10*60` | совпадает (хеш — по Better Auth, проверить в приёмке A-1) |
| Одна позиция на урок | PK `(customer_id, lesson_ref)` | совпадает |
| Токен без email | `playback-auth.ts` claims | совпадает (docs/kinescope-playback-signing.md) |
| Без согласий нет доступа | `hasRequiredAccountConsents` fail-closed | совпадает |
| Запись только явным действием, статус «Начат» | FLEX-128 (A), ещё не реализовано | **G-01/G-02** |
| FREE→PAID сохраняет запись | FLEX-128 (A) | **G-02** |
| Уведомление за 30 дней о снятии курса | механизм служебного письма о курсе не найден | **G-04** |
| Отписка в аккаунте | `recordAuthenticatedConsents(marketingConsent=false)`; UI — проверить | **G-05** |
| Удаление включает все данные просмотра | список `erasure-restore.ts:146-148` | совпадает для существующих таблиц; `course_learning_starts` — назначено A (G-01) |
