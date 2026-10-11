# Flexing 101 — draft catalogue и будущая квалификация Stage A

ART-169 / ART-179 / ART-232. 11.10.2026. **PREPARATION ONLY.** F9 CLOSED, PAYMENT_MODE=disabled, MARKETING_BROADCASTS_ENABLED=false. Четыре canary HTTPS guards сохраняют HTTP 403.

## Редакционное предложение владельцу

Онлайн-курс Flexing 101, автор Арт, бесплатно (0 ₽), без проверки заданий и сертификата, после регистрации с подтверждённым email. Предлагаемый срок доступа — бессрочно, пока курс доступен на платформе; требует утверждения. Kinescope videos ещё не загружены.

| Порядок | Предложенный урок | План, не метаданные видео |
| --- | --- | --- |
| 1 | Что такое флексинг | 3 мин |
| 2 | Контроль тела и базовая изоляция | 5 мин |
| 3 | Первые движения и соединение элементов | 7 мин |
| 4 | Короткая практическая комбинация | 5 мин |

Один раздел «Введение в флексинг». Названия/slug/summary/структура в `apps/platform/lib/launch/flexing101.ts` — DRAFT_OWNER_REVIEW, не опубликованный каталог. Нет выдуманной обложки, videoId, durationSeconds или canonical courseRef. Авторство/права на музыку и записи, фактические длительности и порядок видео подтверждаются до публикации.

## Реальные Payload records без side effects

`prepareFlexing101Draft(req)` — внутренний Local API helper, не HTTP endpoint/seed/autostart. Передать реальный authenticated editorial request с `req.user.collection=users` и отдельной подготовительной SQLite. Live закрытый canary продолжает запрещать запись; helper его не обходит. NODE_ENV/DEPLOY_ENV=production отказывает. Нельзя подключать helper к production или copy/restore тестовую БД в live.

Helper создаёт course → section → четыре lessons в одной реальной DB transaction, через обычные access и hooks (`overrideAccess=false`). `_status=draft`, visibility=unlisted, freePreview=false. Рефы создаёт существующий immutable UUID hook; они идентифицируют действительно созданные записи. Повторный импорт отказывает без изменения refs. Test-generated UUIDs — только fixture, не launch identifiers. При поздней ошибке весь draft tree откатывается.

`proposedMinutes` не записывается в `durationSeconds`. Цена/accessModel остаются proposal: products/offers, payment entitlements и финансовые записи helper не создаёт. В текущей FREE policy просмотр опубликованного бесплатного курса разрешён авторизованному customer после restrictive checks, без фиктивного zero-price order/manual grant. Это existing access model, а не открытие продаж.

## Путь публикации после содержательного одобрения

1. Владелец утверждает четыре legal текста и курс; unresolved legal facts устранены. Активный release создаётся существующим `legal-control` только из одобренных финальных текстов.
2. В подготовительном editorial контуре создаются реальные drafts; из независимого read-back фиксируются фактические courseRef/sectionRef/lessonRefs. При несовпадении фактического состава изменить draft, не выдавать план за запись.
3. Через существующий Kinescope upload/activation pipeline загрузить настоящие материалы каждого урока. Использовать фактический processed videoId, binding, metadata duration и защиту. Проверить обложку/права. Не вставлять произвольный videoId в seed и не объявлять отсутствие upload успешным.
4. Пользоваться существующим Payload publish → immutable manifest → Commerce acknowledgement pipeline. Сначала section, затем соответствующие lessons; проверить фактический version/hash и read-back. Draft manifest builder сейчас отказывает `COURSE_NOT_PUBLISHED`; запуск helper не queue-ит sync jobs.
5. Добавить FREE ONLINE_COURSE product на реальный courseRef по существующему catalog-control/seed контракту, с закрытыми денежными offers. `commerce-v2/launch/catalog.json` в этой подготовке не изменён. Не использовать proposed refs или курс V1 как substitution.
6. Закрытый функциональный E2E допускается лишь после legal/content/video admission и безопасной подготовки предназначенного frontend/proxy. Текущий 403 не снимается автоматически. Production changes и public registration требуют решения владельца.

## ART-179 — подготовленный E2E сценарий, НЕ live PASS

| Шаг | Проверяемый результат / negative control |
| --- | --- |
| Before admission | Нет release → отказ регистрации; stale version/hash → отказ без customer/email; marketing false допустим |
| Реальная почта | NotiSend принятие ≠ получение; владелец получает magic link на контрольный email; URL/token/recipient не пишутся в evidence |
| CAPTCHA | Настоящая серверная проверка; invalid/expired token отказывает; configured не означает PASS |
| Browser frontend | Intended canary Platform, same-origin `/v1/auth`; непривилегированный браузер, TLS/Host/origin из approved configuration; без production fallback |
| Verify | Одна ссылка подтверждает email и binds customer; replay/expired link/foreign callback отказывают |
| Session | Set-Cookie Secure+HttpOnly+host-only, без Domain=.flexperiment.ru; SameSite соответствует сценарию; браузер действительно хранит и использует cookie после navigation/reload |
| Бесплатный доступ | Guest/unverified session не допускается; approved FREE product+fresh published manifest разрешает чтение; stale/unlisted/withdrawn/unknown lesson/video — отказ |
| Видео и прогресс | Реальное protected Kinescope playback, token правильного subject/video; сохранение позиции переживает navigation; чужой lesson/token и expiration отказывают |
| Logout/revocation | Выход удаляет сессию; server-side revoke лишает прежнюю cookie доступа; токен видео остаётся ограничен своим коротким TTL, не обещать мгновенный отзыв уже выданного токена |
| No financial effects | Checkout PAYMENTS_DISABLED; 0 orders/payment attempts/refunds/paid grants/provider calls; marketing broadcasts false |
| После проверки | Capture secrets вне evidence; отдельный статус local integration vs real email/browser/video; backup timers/freshness сохранены |

Локальные tests используют исключительно отдельные SQLite/fixtures, не реальные согласия/видео или подтверждённую доставку. Existing tests: `customer-access`, `auth-email-delivery`, `access-policy`, `playback-auth`, `manifest`, `legal-control`. Новая подготовка не должна переписывать F7 или развертывать неизменённый canary только ради отчёта.

## Два оставшихся owner decision bundles

1. Юридический: [четыре черновика и вопросы](../legal/stage-a/2026-10-11-draft/README.md).
2. Редакционный: план/срок доступа/права/обложка и четыре настоящих видео, сопоставленные реальным lesson records.

До этого ART-169 и ART-179 не Done, ART-232 не Approved, ART-41/F9 HOLD. Production alerting остаётся отдельной ранее зафиксированной F9 предпосылкой; успешные canary alerts не доказывают production delivery.
