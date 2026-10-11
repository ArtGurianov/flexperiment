# Stage A: универсальная подготовка бесплатных курсов

ART-169 / ART-179 / ART-232 / ART-41. Решение владельца от 11.10.2026.

## Решение и границы

Stage A — этап запуска бесплатного доступа, не особая реализация первого курса.
Payload создаёт произвольные course/section/lesson с динамическими immutable refs;
Commerce владеет FREE/PAID, ценой, enrollment и checkout; Kinescope — реальными видео;
Legal Control — версиями документов и admission. Нет обязательного названия, slug,
числа уроков, плановой длительности, seed или course-specific import helper.
Общие acceptance criteria поддерживаются в
[V2 merchant contract](../v2-merchant-schema.md#stage-a-admission-and-course-authoring),
не дублируются в отдельном плане первого курса.

Выбрано удаление неиспользуемого runtime helper с сохранением настоящих Payload
SQLite regressions как универсального authoring-теста. Альтернативы отвергнуты:
оставлять helper ради первого курса или заменять его новым универсальным импортёром.
Обычной CMS и существующих publication/video/commercial pipelines достаточно.
Тестовые данные не являются production-каталогом или юридическим release.

## Сохранённые результаты и незавершённые gates

- Раздельные unchecked ПД/правила и optional marketing обязательны на registration
  boundary до CAPTCHA/DB/email; это не заменяет authenticated подтверждение.
- Migration 0023 маркирует историю LEGACY_UNQUALIFIED, новые заявки UNVERIFIED_INTENT.
  Подтверждение email не доказывает автора прежнего checkbox и не повышает историю.
- Migration 0025 добавляет append-only authenticated actions/events с проверкой
  verified binding, storefront, release/version/hash и идемпотентности. Последний
  отказ/suppression проверяются перед отправкой; старый grant не восстанавливается.
- Authenticated UI/server-side access gate, erasure/retention и независимый
  restore-suppression ledger требуют собственной квалификации. Документы не доказывают
  работу этих механизмов. Live migration/deployment не выводятся из merge или CI.
- Четыре юридических текста получили содержательное owner approval; точные candidate
  bytes и применимость условий поставщиков проверяются отдельно от release activation.
  Исходные drafts/история legal approval сохраняются без переписывания хешей.
- Ручное создание первого настоящего курса и загрузка собственных материалов —
  milestone ART-169, не требование реализации с названием конкретного курса.

ART-179 владеет реальным email/browser/session/video E2E; ART-232 — legal admission;
ART-41 — F9 и production backup alerting. F7, V1, Refref, production, backup timers
и четыре HTTPS 403 guards не меняются. Registration, marketing, payments и F9 CLOSED.

## Следующий независимый delta: required consent gate

Выбран серверный gate в Commerce для library/playback/DRM/progress плюс проверка
consent status перед private Payload reads. Отвергнуты React-only защита и неявное
повышение registration intent после magic-link verification. Entitlements и FREE
enrollment сохраняются исторически, но не обходят required admission.
UI использует unchecked actions, один idempotent POST и независимый GET; неизвестный
результат сверяется GET-only без повторной записи. Scope email marketing переносим
между витринами только для идентичных version/hash, latest decline/suppression
имеют глобальный запрет. Это инженерный механизм, не активация release/рассылок.

## Delta #201: безопасная новая попытка после отказа

Замечание владельца к SHA 9b5ce616: общий `uncertain` блокировал форму даже после
доказанного отказа. Выбран scoped GET конкретного actionKey плюс CAS существующего
event sequence: idle → saving → uncertain/retryable. При ABSENT пользователь явно
начинает новую попытку с новым ключом и пустыми checkbox; COMMITTED, неуспешная или
неполная сверка не разрешают новый POST. Смена release/version/hash пересоздаёт форму.
Сервер различает pre-write/rollback enum errors и неизвестный outcome; HTTP-код сам
по себе не доказывает отсутствие записи. GET не создаёт событий и не отменяет POST.
CAS в immediate transaction исключает двойной COMMIT позднего исходного и нового
действия. Не нужны новые таблицы, миграции или изменение append-only истории.

Отвергнуты возврат idle только по requiredChoicesConfirmed=false (не доказывает
отсутствие action), слепой повтор старого payload (может изменить выбор) и отдельный
ledger попыток (лишняя схема для существующих последовательных events).
Logout, история покупок и контакт удаления ПД остаются доступны вне content gate.
UI/domain/API tests покрывают отказ, ambiguous COMMIT/absence, отказ GET, чужой key,
смену редакции, оба порядка late-commit race и независимый session read-back.
Erasure/retention и independent restore-suppression остаются отдельным delta ART-232.

## ART-232: независимый erasure ledger — первый инженерный slice

База: merge #201 `180eb165f34c1c94de5566ee5c364c69ffc24450`. Выбран отдельный
owner-side SQLite journal, HMAC-псевдонимы, Ed25519 signatures и hash chain.
Отвергнуты tombstones в merchant SQLite (возвращаются из старого backup) и отдельный
журнал с raw email/claims (ненужная копия ПД). Генерации subject/signing keys сохраняются
в отдельной custody; приватные signing keys не нужны restore consumer. Псевдонимы —
ПД, не анонимизация. Подписанный fingerprint поколения subject key предотвращает
тихую потерю совпадений при подстановке неправильного ключа той же длины.

Первый slice — библиотека, не активный HTTP deletion endpoint или host installation.
Ledger находится вне merchant/editorial/snapshot roots, owner-only 0700/0600,
EXTRA synchronous SQLite append + DELETE journal с независимым read-back PRAGMA;
отдельные writer connections сериализуются. EXTRA синхронизирует directory journal
unlink; FULL не гарантирует последний commit при близком power loss на всех FS
([SQLite contract](https://www.sqlite.org/pragma.html#pragma_synchronous)). Это не
power-fault proof VPS и не замена независимому remote acknowledgement.
Append-only sequence/request identity, scopes canary/production, previous hash,
fixed kind, signing key ID и подпись проверяются полностью. requestId idempotent
только для тех же kind/subject. Capacity/clock regression/unknown generation → STOP.

Restore consumer запрашивает новый nonce-bound checkpoint у независимой актуальной
authority; signature + scope + head/count + issuance freshness обязательны.
Saved checkpoint или watermark из восстанавливаемой DB не подходят. Capability
immutable, expires за 60 секунд; старый complete signed bundle не проходит сравнение
с newest head. Callback adapter обязан обращаться к independently current authenticated
authority без cache/fallback. В этом slice используется настоящая независимая local
SQLite в isolated tests; remote durable acknowledgement, authentication/fencing,
encrypted export и off-VPS key escrow **ещё не установлены/не квалифицированы**.
Подмена latest authority её старой резервной копией вне модели допустимого adapter.

Isolated restore применяет ERASURE к точным customer/user identities, восстанавливает
email suppression и отменяет pending campaign recipients. Новая same-email identity
не удаляется по email, но старый marketing opt-in не снимает suppression. FK-order
purge удаляет Stage A consent events, FREE receipts, progress/telemetry и auth outbox;
ALL restored sessions/magic links invalidated before subsequent runtime admission.
Unknown FK, financial history, subject binding drift или неклассифицированный audit →
transaction rollback/HOLD. Никаких отключённых FKs, переписанных consent events или
выдуманных legal holds. `secure_delete` — только снижение остаточных cell bytes в
isolated copy, не доказательство уничтожения WAL/offline archives/SSD.
Полный DDL fingerprint схемы0001–0025 закреплён отдельно от restore input; новая
таблица без FK, колонка или trigger требуют явной requalification, не silent purge.

После проверки не возвращается runtime PASS: serving/jobs/mail остаются PENDING.
Следующие отдельные slices: authenticated/manual request admission + durable remote
append ordering and immediate suppression/session revocation; retention/processor
tasks and offline archive policy; boot/send-boundary/fencing integration. После них
подготовить private-canary admission migrations0023–0025/subsequent schema/E2E.
Не допускать restore к трафику только по успешному isolated purge.
