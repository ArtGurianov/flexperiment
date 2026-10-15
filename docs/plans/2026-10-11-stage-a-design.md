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

## Следующий независимый delta: category retention

Выбран отдельный offline SQLite engine с явной проверяемой policy и bounded holds;
ни server, ни jobs, ни CLI его автоматически не вызывают. Это не новые действующие
юридические сроки: defaults отсутствуют, synthetic test policy не является approval.
Отвергнуты универсальный TTL аккаунта (удаляет историю без классификации), cleanup
в работающем runtime (SQL не останавливает уже отправляемое письмо) и count-only
retention архивов (не ограничивает возраст и не покрывает offline копии).

Engine обслуживает expired sessions/verification, encrypted auth outbox, playback
telemetry и доказанно старые UNVERIFIED_INTENT без аккаунта, истории или новых фактов.
Полный canonical DDL 0001–0025 проверяется внутри immediate transaction; неизвестные
schema/timestamps/verification shape требуют review и откатывают все удаления.
LEGAL_CLAIM/SECURITY_INVESTIGATION/PROCESSOR_CONFIRMATION требуют явных reference,
reviewer и конечной даты; истёкший hold требует disposition, не исчезает автоматически.
Формат evidence/reference не доказывает полномочия reviewer: admission caller ещё
не установлен. Account/qualified consents/suppression/financial facts сохраняются.

Архивная функция только планирует exact scoped objects по возрасту и SHA-256,
сохраняя текущий проверенный архив и удерживаемые копии. Она ничего не удаляет.
Полный VPS/Cloud.ru/Mac inventory, реальная policy approval, независимый suppression
ledger, processor coordination и runtime installation остаются отдельными gates.
secure_delete не доказывает очистку WAL, дисков или старых ciphertext.

## ART-232: verified request и remote custody — отдельный неактивный slice

Сохраняем original plan: подписанный независимый ledger, retained key generations,
full-schema isolated restore gate, явный retention и CLOSED operational boundaries.
Из предложенного продолжения принимаем два отдельных PR (material improvement:
reviewable failure boundaries), verified identity + remote ACK (critical fix:
local append не переживает потерю VPS) и runtime/send fencing (critical fix:
remote ACK сам по себе не завершает in-flight auth/email). Не принимаем активацию
первого slice без второго: нельзя объявлять live deletion admitted при работающих
отправителях. Owner decisions для кода не нужны; установка остаётся отдельным gate.

Request capability выдаётся только сервером из действительной Better Auth session
и текущей verified user/customer/session binding. Exact Origin обязателен; client
передаёт только requestId, не email/customerId. Перед append binding перепроверяется;
capability expires60s и не создаётся структурной подделкой. Content-consent gate
не блокирует запрос удаления. Email в art@ — PENDING_IDENTITY_VERIFICATION, не
доказательство владения аккаунтом и не команда на удаление.

Owner-side custodian: local signed append → age public-recipient encrypted complete
bundle → immutable remote conditional create → signed head CAS → independent GET
exact ciphertext/head → fresh nonce-bound checkpoint. Store/keys не устанавливаются
в Commerce; private recovery identity нужна только independent restore. Состояние
REMOTE_DURABLE_CONFIRMED означает custody, не физическое удаление/processor ACK.
Потерянный ответ submit сверяется GET-only с тем же requestId. Pending публикация
возобновляется только явной owner operation publishPending, с GET-first и CAS, без
нового erasure event. Missing head не создаёт genesis автоматически; initialization
отдельная операция только с пустым local ledger. Remote-ahead/fork/tamper → CLOSED.

Risk delta: direct SDK dependency закреплена за уже имеющейся в lockfile версией
3.1143.0 без upgrade Payload/S3 dependencies. Новый adapter требует отдельно доказать
Cloud.ru conditional-write contract, off-VPS storage independence, no-delete IAM,
anti-rollback authority и recovery/signing/subject escrow. AWS S3 If-Match/If-None-Match
contract не является доказательством поведения конкретного Cloud.ru аккаунта.
Adapter допускает только scoped GET/conditional PUT, maxAttempts1, bounded streams,
HTTPS, explicit owner credentials; никаких list/delete/unconditional/retry fallback.

Tests используют реальные SQLite, Better Auth, age encryption/decryption и SDK
SigV4 serialization; remote SQLite fixture НЕ доказывает off-VPS/Cloud admission.
Failure injection: before-upload, uploaded ciphertext/lost ACK, committed head/lost
ACK, stale authority, CAS conflict, reflected secrets, bounded malformed reads.
Следующий PR должен закрывать admission/send/auth/restore гонки до любой live установки.
Deployment, live migrations, legal activation, registration, marketing, payments/F9
по-прежнему CLOSED. Existing foundation/recovery evidence не повторяется.

## ART-232 / ART-179: runtime/send fencing — второй отдельный slice

Выбран один shared independent SQLite fence для всех Commerce HTTP requests,
auth callbacks, campaign и reconciliation workers. Durable lease держится до конца
async handler/transport и последующей записи результата. Отвергнуты per-process bool,
проверка suppression только перед await(send), lease timeout как доказательство
завершения и reopen по watermark восстанавливаемой merchant DB: они оставляют гонку.
Неизвестная доставка сохраняет отдельный UNKNOWN SEND lease, даже если Better Auth
или campaign catches error; падение процесса оставляет ACTIVE. Автоматического expiry,
retry, удаления lease или подмены provider ACK нет. Эти состояния требуют evidence-bound
operator reconciliation, которого этот slice намеренно не автоматизирует.

Owner admission: fresh verified request → CLOSED → zero active/unknown leases →
exclusive owner claim → remote custody ACK → canonical schema/binding/hold checks →
atomic erasure/suppression/revocation → newest remote read-back → OPEN. Нет новых
merchant migrations. Purge общий с isolated engine, но LIVE_ADMISSION сохраняет
чужие сессии/links; BOOT_RESTORE отменяет ALL sessions/verification. Выдаваемая
application receipt доступна только как process-private capability результата
реального transaction; JSON receipt и signed ledger без application не открывают gate.
Financial/audit/unknown schema/token shape → rollback/CLOSED, не выдуманный legal hold.
Remote accepted erasure не становится processor/archive deletion PASS.

Runtime opt-in ERASURE_FENCING_ENABLED=true требует approved independent HTTPS
read authority (/v1/erasure/read), scoped read token, protected retained public/HMAC
verification-key file и уже initialized shared fence directory. Отсутствующий fence
не создаётся автоматически. Сервисы не получают S3 credential, Ed25519 private signer
или age recovery identity. До auth/HTTP/timers boot читает fresh nonce-bound remote
ledger, применяет BOOT_RESTORE за drain и сверяет head ещё раз. Missing/stale/forked
authority, orphan owner/leases и unknown schema держат startup CLOSED. Existing CLOSED
deployments без flag сохраняют прежнее поведение только с явным owner admission
NEVER_INSTALLED; отсутствие host evidence не считается этим состоянием.
Opt-in не установлен этим PR.
Повторный boot не понижает independent applied watermark: даже свежеподписанный
nonce-bound ответ должен включать уже применённый prefix с тем же hash.
Rollback или fork → CLOSED; freshness сама по себе не доказывает полноту ledger.

HTTP middleware покрывает весь request; /readyz отдельно проверяет fresh authority
и gate, /identity остаётся доступным. Better Auth create-user/create-session hooks,
verified customer lookup и magic-link transport проверяют signed suppression.
Async child после завершения родительского request не имеет действительного lease.
MARKETING_SUPPRESSION не лишает аккаунт контента или сервисных magic links:
AUTH_MAIL и MARKETING имеют отдельные purpose. Отказ блокирует только MARKETING;
ERASURE блокирует прежнюю identity и implicit same-email resurrection. Повторная
регистрация после erasure потребует отдельной явной модели, а не старого opt-in.
Logout вне content consent gate; during CLOSED любые customer paths временно fenced.

Все production/closed-canary volumes, guards, backups и activation remain unchanged.
Код предоставляет in-process owner admission, НЕ публичный deletion HTTP endpoint
и НЕ установленный remote authority service. Перед live установкой требуется review
канала authenticated requests, проверка единственного общего control volume/всех
writers (включая Local API/custom jobs), отсутствия out-of-band DB writes, CAS/IAM и
custody. Запрещено восстанавливать fence из merchant backup или создавать второй
параллельный fence для существующих writers. Payload/processor cleanup и offline
archive disposition квалифицируются отдельно; текущий canonical Stage A customer
purge не является доказательством удаления у внешних providers или на SSD/WAL.

Causal regressions второго slice: async request и настоящий auth callback до DB
write, pending network send >60s, SIGKILL child-process persisted lease, swallowed
unknown send, delayed async children, forged application receipt, freshest-head
rotation, older real SQLite backup, unrelated LIVE sessions vs BOOT invalidation.
Четыре намеренные мутации (ignore leases / release UNKNOWN / allow late async /
skip application receipt) пойманы targeted tests; исходная реализация восстановлена.
Дополнительная причинная мутация удаления prefix guard обнаруживает возможность
понижения watermark после restart; guard восстановлен, состояние остаётся CLOSED.
Full exact-head CI обоих PR обязателен перед возможным merge; инженерный PASS
не разрешает deployment, live migrations, legal release, registration/marketing,
payments или F9.

## Delta review #204/#205: installation downgrade — 12.10.2026

### Keep from original plan

Retained keys, independent signed remote custody, fresh nonce/checkpoint, applied
prefix anti-rollback, durable drained REQUEST/WORKER/SEND и operational HOLD сохраняются.
#204 merge выполняется первым; #205 обновляется к main и получает новую exact-head CI.

### Adopt from alternative plan

Critical fix: installation admission должен читаться независимо от env и merchant
backup. После REQUIRED отсутствие/false fencing не запускает DB/auth/HTTP/timers.
Material improvement: foundation startup тоже проверяется — иначе переключение
COMMERCE_V2_FOUNDATION_MODE могло бы обойти prepareErasureRuntime.

### Reject from alternative plan

Не используем отсутствие файла как NEVER_INSTALLED: оно неотличимо от потери mount
после установки. Не принимаем env-selected path, marker внутри merchant SQLite,
бaked legacy marker в image или автоматическую генерацию пустого installation state.
Никакие merchant migrations не нужны; runtime не получает writer installation policy.

### Conflicts / decisions needed

Для совместимости закрытых never-enabled окружений выбран явный owner-managed
NEVER_INSTALLED record. REQUIRED — последующее защищённое owner admission. Переключение
этого host record не выполняется env/API приложения. Полномочия установки ещё HOLD;
routine engineering не требует нового GO.

### Risk delta

Новая обязательная deployment dependency: отдельный root-owned read-only host mount
/etc/flexperiment-erasure (0555), installation.json (0444, UID 0, без symlink/hardlink).
Kernel mountinfo подтверждает точный ro mount. Host namespace находится вне merchant,
editorial, backups и image. Record v1 связывает scope и installationId; REQUIRED
закрепляет canonical fenceDirectory, который нельзя перенаправить env на пустой fence.
После установки owner registry не восстанавливается из старого merchant backup;
его rollback/removal требует отдельной защищённой operator procedure, не runtime repair.
Неверный scope, отсутствующий/corrupt/RW/unmounted record → CLOSED даже без flag.
Проверенный ранее runtime image НЕ заменяется этим инженерным merge.

### Revised merged plan

1. Merge #204 при утверждённом head и сохранить merge-SHA CI.
2. Обновить #205 к main; добавить private installation capability и unconditional
   startup admission. NEVER_INSTALLED сохраняет closed legacy behavior; REQUIRED
   требует включённого fencing, pinned scope/path и qualified remote boot.
3. Квалифицировать отказ при missing/false, старом merchant backup, missing/corrupt
   evidence, foreign scope/path, RW mount, недоступной custody и foundation fallback.
4. Actual-image CI использует только task-owned synthetic host volumes. Root metadata,
   ro mount и невозможность записи из app проверяются реально; host unit tests явно
   используют synthetic mount adapter. Synthetic record не является live installation.
5. Fresh exact-head test/docker-build PASS перед merge #205, затем post-merge CI.
   Remote authority, transport, IAM/CAS, key escrow, all-writer fencing installation
   остаются отдельными live gates. Deployment/live migrations/F9 не выполняются.

## CI prerequisite: Payload CLI migration completion — 12.10.2026

#204 merged/verified at 684ae1f8a17faf02658aace759cb798b9ac80116, exact post-CI
38158970092 test/docker-build SUCCESS. #205 downgrade correction 2bbcf331 remains
unmerged: fresh CI38160305323 test SUCCESS (3047 root/205 Platform/77 export), but
Platform actual-image catalogue failed with no courses table. Remaining Docker work
was canceled immediately; no unchanged-SHA rerun and no weakened schema/health gate.

Existing Payload CLI can exit 0 without executing migration. Isolated pinned Node
22.23.3/Payload3.90.2 image reproduced this on fourth fresh CLI invocation under
bounded CPU contention: exit0, no SQLite file. Native Node26 three probes and Node22
five unconstrained probes succeeded; those did not disprove the intermittent defect.
Upstream 3.x correction: https://github.com/payloadcms/payload/pull/18398.
Do not infer the exact internal import predicate solely from the CI response.

Keep: pinned Payload3.90.2, Lexical0.50.0, current tsx, actual CLI/migrations, existing
editor/runtime/API behavior and strict image smoke. Adopt a CLI-only narrow backport:
load the same environment loader, resolve Lexical's equivalent static dev/prod export,
preserve explicit conditions/foreign packages, and fail nonzero on unfinished CLI
beforeExit. New preload applies only to platform migrate, before Next start. No
dependency upgrade, pnpm patch, schema push, migration rewrite, delay/retry or mock
schema replacement. Existing package source COPY already ships the two preload files.

Causal subprocess controls use the actual pinned CLI: an unsettled target exits0
without protection and nonzero with it; explicit success/failure codes remain intact.
Removing static-export selection restores the real Lexical.node.mjs path and fails
both dev/prod assertions. Actual config applies all six migrations and repeats
idempotently. Isolated old-image Node22 with read-only bound new preload passed three
fresh migration/schema/integrity checks; this is not exact-new-image CI attestation.

Focused prerequisite commit kept separate from fencing changes within existing
#205; no extra workflow/controller/PR cycle. New exact-head CI and merge-SHA
admission are required for the composed source. No live
deployment, migrations, production/V1/Refref/routing/secrets/activation. LIVE_ERASURE
and legal release remain HOLD; existing ART-232/179/41 only, no new issues.

## Library integration under fixed threat model — 12.10.2026

Authority: owner-approved [revision 2fd8b780](https://github.com/ArtGurianov/flexperiment/blob/2fd8b7805e3b6308394f92744cf6eeb3c6047238/docs/plans/2026-10-11-stage-a-design.md#threat-model--%D0%BE%D0%B4%D0%B8%D0%BD-vps--cloudru).
This section supersedes earlier installation requirements for an off-VPS HTTP
authority. One existing VPS/Coolify + Cloud.ru; no new daemon, server or mandatory
`/v1/erasure/read`. In scope: stale backups, accidental rollback/configuration,
VPS loss, partial writes/lost ACK, concurrent writers/sends. Malicious root and
deliberate privileged ledger tampering are out of scope. Normal secret custody,
permissions, signature verification and fail-closed remain required.

### Read admission, not another ledger

`erasure-library-read.ts` uses a scoped read-only AWS SDK identity with explicit
Cloud.ru endpoint/region/bucket/prefix/expected owner and no implicit credentials,
PUT/Delete, redirects or retry. Each admission reads the actual current signed
head, exact encrypted packet, matching full signed bundle and a second head. The
local bundle is an owner-exported **existing ErasureBundle format**, mounted RO,
not independent authority or an ACK. Stale/missing mirror, failed read, missing
key generation, different scope/recipient, corrupt packet or a fork keeps CLOSED.
Runtime receives verification/HMAC generations + read credential only: no private
signer, age recovery identity, writer credential or writable owner journal.

**ART351 amendment (15 October):** the zero-repeat current-reader behavior above
is superseded by one finite full GET-only re-verification for typed transient
failures. SDK retries, write retries, stale fallback and automatic admission
reopen remain prohibited. See [reader resilience design](2026-10-15-art-351-reader-resilience-design.md)
and [qualified recovery](../release/ART-351_READER_RECOVERY.md).

Cold-reader admission checks retained signed head versions to detect accidental
remote rollback even after losing the local prefix. Versioning must be Enabled;
null/duplicate/missing versions, delete markers and incomplete pagination fail
closed. Bounds: 10 pages of 100 versions, batches of 8 version reads. Crossing
the history/ciphertext capacity is a separate review, never permission to discard
old history. The checked historical prefix is retained in-process; every subsequent
read still obtains uncached current head/packet/head and rejects a lower/forked
prefix. This is **not** proof of Cloud.ru consistency or anti-malicious-root defense.

Protected installation record remains v1; REQUIRED additionally pins
`readerBindingSha256` for scope + endpoint/region + bucket/prefix + expected bucket
owner + recipient digest. Actual library startup and owner CLI require this pin;
old trusted core-test seams are not a runtime fallback. Runtime configuration file
and bundle must be UID-app 0600 regular single-link files in independently
RO-mounted directories outside merchant/fence roots. Kernel mountinfo is checked.
Missing REQUIRED evidence, flag downgrade and foundation fallback remain refused.
Startup umask 0077 protects newly created SQLite/WAL files; it neither repairs nor
qualifies existing live permissions.

### Small owner-only CLI, no live installation in this change

Run from the admitted image/operator namespace with the same admitted app UID,
fixed root-owned RO installation record, an exclusive shared fence and owner-only
0700 custody/mirror directories:

```sh
node --import tsx commerce-v2/src/erasure-owner-cli.ts --config /private/owner.json
```

The 0600 JSON config explicitly pins canary scope, existing merchant databasePath,
ledgerDirectory, fenceDirectory, mirrorFile, keysFile, subjectKeyId, signer keyId
and privateKeyFile, age **public recipient**, remote endpoint/region/bucket/expected
owner and separate read/write key-file paths; optional private authEnvironmentFile
contains the existing Better Auth secret/origins. No secret values in argv, reports,
CI, env publication or application config. Operation is strict bounded JSON on
stdin. Supported explicit operations:

- `inspect`: metadata only; never create/query remote or claim admission.
- `initialize-fence`: new CLOSED control journal only; existing file is refused.
- `initialize-custody`: explicit empty owner journal/conditional remote genesis;
  no automatic initialization from a failed read.
- `resume-initialization`: same empty journal after interrupted initialization;
  read-first, reuse exact packet, never overwrite committed head or create keys.
- `read`: validate current remote custody, no private signer/write-key access.
- `publish-pending`: same pending journal after ambiguous ACK; GET-first, no new
  request or replay of an already committed PUT. Remains CLOSED.
- `reconcile`: fresh remote read → mirror export → LIVE purge under drain; no bank,
  new ledger entry or PUT. Unknown sends/crashed owner claims stay HOLD.
- `recover-ledger`: absent local journal only, exact retained signed entries from
  owner-recovered bundle verified against latest remote history/packet. No resigning,
  new key generation or PUT; remains CLOSED until boot/restore admission.
- `admit`: requestId + authenticated Cookie/approved Origin through stdin, identity
  derived by real Better Auth. Raw email/user claims are refused. Drain → append →
  remote durability ACK → fsynced atomic mirror → purge → fresh read → reopen.
  Mirror/ACK failure leaves CLOSED. Manual email case still needs verified identity.

After VPS loss, escrowed generations and the current Cloud.ru ciphertext must be
recovered privately; use existing age recovery offline to obtain the exact bundle.
Do not restore an old owner journal/fence as authority. `recover-ledger` rejects a
stale bundle, unverifiable remote state or existing journal; actual runtime boot
still uses BOOT_RESTORE and invalidates restored sessions before traffic. CLI never
clears UNKNOWN leases or owner claims by TTL. Those require independently evidenced
operator reconciliation, not automatic repair. Processor deletion and old/offline
archive disposition remain explicitly PENDING rather than implied by SQLite purge.

### Remaining operational gates (ART-232 / ART-179 / ART-41)

**EXECUTION_HOLD**: synthetic real-SDK/SQLite/age/auth tests are engineering evidence,
not operational admission. Before installation separately qualify Cloud.ru endpoint
and expected-owner compatibility, versioning/history retention and read IAM,
conditional If-None-Match/If-Match behavior and concurrent CAS, durable read-back/lost
ACK, isolated namespace, writer authority, key escrow and loss-of-VPS recovery.
Inventory every SQLite writer and migrations/jobs/mail; one shared fence, exclusive
replacement (no overlapping old/new writers), independent RO record/read mirror and
actual permissions are mandatory. Existing backup timers/evidence remain unchanged.
No deployment, live migration, custody initialization, public registration, legal
activation, marketing, payment, production/V1/Refref change or F9 is admitted here.

### Host admission integration — 12.10.2026

Owner subsequently authorized Flexperiment canary host installation and one isolated
erasure/old-backup recovery proof. This does not authorize production or public
activation. The real state bucket is `flexperiment-erasure-canary-state`; retained
TEST history stays separate and read-only. Do not reset the TEST head or repeat
accepted provider CAS/recovery-baseline qualification.

The existing normal-canary controller must admit exactly the two preserved named
SQLite/backup volumes plus five fixed canary host binds: installation, runtime keys,
reader configuration and bundle mirror read-only; shared fence read-write. Coolify
4.4.6 creates new host binds as native Directory records (`file_storages` with
`is_directory=true`, `is_host_file=false`, no content), and emits `fs_path:mount_path`;
legacy persistent records use `host_path:mount_path`. Admit either exact five-bind
representation, not mixed/arbitrary file mounts. Storage mount paths include
`:ro`/`:rw`; no custom Docker command or routing override is needed. The API's named
volume name is already the complete Docker name; do not prepend the UUID again.
Runtime gets
only verification/HMAC generations and scoped reader credentials, never signer,
writer or age recovery identity.

Before any source-pin mutation, owner admission binds the exact source, protected
REQUIRED marker, installation ID, reader digest, private file ownership and completed
isolated recovery proof. It also reads current Cloud.ru custody through the existing
one-shot owner CLI. Before enqueue, stop only Commerce canary through Coolify,
wait for stopped state, and refuse competing RW mounts or host DB/WAL file
descriptors. Repeat admission and exclusive-writer checks immediately before POST.
No overlapping replacement, automatic retry, downgrade or unfenced rollback.

Runtime verification must independently inspect actual bind sources/access modes
and require `capabilities.erasure=qualified`. Legacy foundation admission and
production remain unchanged. Revalidate every frontend's timestamp-based Commerce
upstream after replacement; Healthy frontend alone is not upstream readiness.
