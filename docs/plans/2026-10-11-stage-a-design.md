# Stage A: универсальная подготовка бесплатных курсов

ART-169 / ART-179 / ART-232 / ART-41. Решение владельца от 11.10.2026.

Текущий операционный план: [Canary erasure installation/admission — 12.10.2026](#canary-erasure-installationadmission--12102026).
Это подготовленный план, не разрешение на установку или live migrations.

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

## Canary erasure installation/admission — 12.10.2026

**PLAN_PREPARED / EXECUTION_HOLD.** План дополняет существующий Stage A contract,
не вводит новую erasure-модель. Техническая база — merge #205
`0d8def5549be0b4b6f9a26a630d19f82a3455a18`, tree
`fcf76c3dca4ab46b349084423fd0602de6000293`; exact-head и merge-SHA checks SUCCESS.
Документационный commit этого плана не является deployment source или новым image.
Ни одна команда установки в этом разделе ещё не выполнена.

После заполнения bindings требуется одно ограниченное canary execution authorization:
новые изолированные custody/key/mount ресурсы, controlled S3 contract writes,
offline copy proof, exclusive canary migration/replacement и private failure checks.
Gates ниже — технические STOP/PASS, не запросы нового ручного GO на каждый шаг.
Изменение production, публичных guards или legal/registration admission в это GO
не входит; обнаруженная смена scope требует остановки, не расширения полномочий.

### Keep from original plan

Сохраняем signed ledger, encrypted remote bundles, fresh nonce-bound checkpoint,
independent applied prefix, verified account capability, REQUEST/WORKER/SEND leases,
отдельные authoring/legal/E2E gates. Принятые backups и frontend qualification не
повторяются без изменения проверяемых условий. Production/V1/Refref/F7 неизменны;
`PAYMENT_MODE=disabled`, `MARKETING_BROADCASTS_ENABLED=false`, четыре публичных HTTPS
403 guards, registration/offers/legal activation/F9 CLOSED.

### Adopt from alternative plan

- **Critical fix:** установить host admission до допуска нового runtime. Отсутствие
  mount или запись NEVER_INSTALLED после REQUIRED не является допустимым rollback.
- **Critical fix:** доказать реальный Cloud.ru CAS/IAM и независимость read authority,
  не выдавать SDK/local tests за installed custody.
- **Critical fix:** inventory всех writers и exclusive migration/replacement. Runtime
  fence не защищает произвольный SQL или standalone migration по факту наличия mount.
- **Material improvement:** доказать newest-ledger suppression на старом архиве в
  отдельной копии до замены действующего canary. Это изменённое recovery-условие,
  не повтор общего infrastructure proof.
- **Material improvement:** отдельные результаты custody / all-writer / recovery /
  functional E2E; ни один из них не означает production или legal activation.

### Reject from alternative plan

Не переносим порядок пяти приоритетов в слепой набор уже исполнимых команд: пока не
привязаны authority endpoint, IAM и owner launcher, такой набор был бы вымышленным.
Не считаем nonce authority простой выдачей старого signed JSON из S3: нужен новый
checkpoint после независимого current-head/read-back. Не добавляем новый ledger,
универсальный daemon/controller или повтор всего CI ради подготовки плана.

### Conflicts / decisions needed

В текущем source подтверждены конкретные installation gaps, а не дефекты новой модели:

1. `erasureRemoteReadAdapter()` требует HTTPS `GET /v1/erasure/read`, bearer token,
   `x-erasure-nonce`, uncached ответ `{bundle,checkpoint,custodyHead}`. В репозитории
   нет server/launcher этого endpoint. `ErasureCustodian.reconcile()` — библиотечная
   операция, не установленная independent service. Размещение/URL ещё НЕ привязаны.
2. `prepareErasureRuntime()` открывает fence только без `initialize:true`:
   предварительная owner initialization обязательна. Готового operator launcher для
   неё и `admitVerifiedErasure()` нет. Test harness не является operational launcher.
3. `commerce-v2/src/migrate.ts` не читает installation policy/fence. В `server.ts`
   `migrateV2()` идёт после policy check, но ДО remote/fence boot. Значит, migrations
   допускаются только offline/exclusively; simultaneous boot/replacement запрещён.
4. `scripts/v2/owner-rpc.py` не устанавливает erasure env/mount/authority. Его существующий
   deploy может использоваться после staging, но не считается erasure admission.

Перед execution нужно подтвердить существующий подходящий transport либо подготовить
минимальный reviewed operational wrapper вокруг уже merged APIs. Не устанавливать
signer/S3 credentials в Commerce и не сериализовать private VerifiedErasureRequest в
JSON. Отдельного продуктового/юридического решения для подготовки этих bindings нет;
операционная установка и новые canary keys требуют installation authorization.

### Risk delta

Новый обязательный mount блокирует boot даже с missing/false flag. Runtime verification
file содержит PUBLIC signing keys и секретные subject HMAC keys всех сохранённых
поколений; это не «публичный конфиг». Signer/age identity/S3 writer не попадают в app.
BOOT_RESTORE инвалидирует ВСЕ восстановленные sessions/magic links, LIVE_ADMISSION —
только целевое удаление. Unknown SEND/owner crash не освобождаются по таймеру.
Commerce purge не удаляет Payload editorial DB, provider storage, logs, WAL/SSD или
offline ciphertext. Эти disposition остаются явными gates, а не заявлением erasure PASS.

### Revised merged plan

#### 0. Exact bindings и read-only preflight

До первой mutation сохранить private admission journal с approved source, actor,
временем, точными resource IDs, baseline fingerprints и evidence references.
Предлагаемый journal: `/root/flexperiment-v2-owner/erasure-admission.json`, UID0/0600;
это новый планируемый файл, не заявление о его существовании. Секретные значения,
PII, JWT/session headers, plaintext bundles и произвольные provider bodies не писать.

| Binding | Значение / требуемый read-back |
| --- | --- |
| Commerce canary app | `xzuy7pk5y6ywjr9kh6nsk5ap`, port3002; проверить имя/destination/единственный current container |
| Source / image | `0d8def5549be0b4b6f9a26a630d19f82a3455a18`; записать actual build digest и baked identity, не подставлять digest из старого review image |
| Protected resources | LAB `ch8gumpvpriflqsct7clqafr`, Admin `v2w4tnlkkt8pj2fnfspyn5l5`, Platform `ks8c2wmlle1kvdfuwbiwthe1`; production/V1/Refref IDs брать из owner inventory |
| Merchant DB | current qualified canary volume, `/var/lib/flexperiment-v2/commerce.sqlite`; host source/inode/lineage/ledger определить read-only |
| Owner policy | proposed host `/var/lib/flexperiment-erasure-canary/installation` → fixed app `/etc/flexperiment-erasure:ro` |
| Shared fence | proposed host `/var/lib/flexperiment-erasure-canary/fence` → app `/var/lib/flexperiment-erasure-canary/fence:rw` |
| Verification keys | proposed host `/var/lib/flexperiment-erasure-canary/runtime-keys` → app `/etc/flexperiment-erasure-keys:ro`; actual filename/retained key IDs bind privately |
| Owner ledger / keys | independent owner-only directory вне merchant/editorial/fence/archives; host/service UID, signing/subject generations и escrow ещё bind/verify |
| Remote objects | exact adapter prefix `flexperiment/erasure/canary/`; endpoint/region/bucket/IAM identity UNBOUND, не наследовать broad backup credentials |
| Read authority | independent off-VPS current-head authority; HTTPS host, token custody, certificate и launcher UNBOUND |

Пути proposed, а не найденные live directories. Провести API + independent metadata
read-back; не выводить `docker inspect .Config.Env`, private JSON или содержимое ключей.
Подтвердить zero public FQDN/host ports/auto-deploy/previews/log drains; no queued job.
Сопоставить все write-capable mounts/processes/cron/systemd/deploy commands. Проверить
backup freshness и existing guards; текущие backups/timers не отключать.
Снять schema lineage, exact migration ledger, safe counts и fingerprints (без rows).
Наличие real users/financial or unclassified audit facts → отдельный admission HOLD,
не очистка базы ради теста. Не предполагать, что source data по-прежнему пусты.

**Gate0:** bindings полны, baseline непротиворечив, authority/owner launcher reviewed,
installation authorization зафиксировано. Иначе дальнейшие фазы НЕ запускать.

#### 1. Independent custody / keys / actual S3 contract

Сначала isolated qualification без замены текущего Commerce. Использовать отдельный
неавторитетный qualification bucket с тем же проверяемым permission contract и exact
adapter prefix; его фактическое имя/владельца записать до PUT. Не использовать
production namespace или authoritative `head.json` для destructive negative controls.

1. Проверить действительные capabilities: If-None-Match create, stale/current ETag
   If-Match CAS, concurrent publisher conflict, bounded GET и exact bytes/hash read-back.
   Lost-response injection после фактического commit → только GET reconciliation,
   без повторного submit/PUT. Неподдержанный CAS → HOLD, не unconditional overwrite.
2. Доказать effective IAM: immutable bundles защищены от overwrite; head обновляется
   только conditional CAS; DELETE/list/cross-environment/broad backup privileges не
   нужны writer. Отрицательные destructive probes — только на явно disposable объектах.
   Similar test-bucket policy не доказывает IAM итогового bucket: его permissions и
   реальные безопасные negative controls квалифицируются отдельно.
3. Подготовить отдельные canary signing/subject generations и read token после GO;
   не ротировать существующие application/production keys. Ed25519 signer приватный;
   subject HMAC32bytes; age private identity только в off-VPS recovery custody.
   Независимо проверить decrypt + retained signing/subject keys с public fingerprints.
4. Owner `ErasureLedgerStore` 0700/0600, actual owner UID, вне всех data/backup roots;
   DELETE journal / synchronous EXTRA подтвердить read-back. Нельзя заменить его
   старым merchant archive или молча создать пустой журнал после потери authority.
5. На окончательно admitted canary bucket genesis публикуется явно через
   `initializeEmptyCustody()` только если local ledger пуст И remote head отсутствует.
   Найденный head/ledger с событиями → reconciliation/HOLD; никогда reset/delete.
6. Independent authority выполняет `reconcile(null,nonce)` по актуальной owner ledger
   и remote head/packet read-back, затем выдаёт fresh подписанный checkpoint. Проверить
   nonce, scope, signature, head/count, ≤60s freshness, no-cache/no redirects/rollback.
   Static file, mounted copy на VPS или mock `fetcher` не являются installed authority.

**CUSTODY_PASS:** actual contract + final IAM + off-VPS recovery + uncached authority
доказаны. Это пока не запуск runtime и не admission удаления пользователя.

#### 2. Protected installation и предварительно CLOSED fence

Все новые пути отдельные; existing volumes не пересоздавать. Host policy directory
UID0/0555, `installation.json` UID0/0444, regular/nlink1/no symlink, ≤4096bytes;
fixed kernel mount в app ровно один и ro. Proposed host parent owner-only.

```json
{"version":1,"installationId":"<new admitted UUID>","scope":"canary","state":"REQUIRED","fenceDirectory":"/var/lib/flexperiment-erasure-canary/fence"}
```

UUID — input owner admission, не literal template для установки. Записать canonical
record hash в независимую custody. Marker не входит в merchant backup/restore.
NEVER_INSTALLED допускается только для действительно никогда не installed closed
lane, не для rollback REQUIRED. Не менять действующий canary до фаз3–4.

Fence directory 0700 и файл0600, владельцем фактический app UID (проверить `id`,
не предположить UID по названию image). Keys file0600 с тем же UID, ro mount.
Owner launcher один раз создаёт `ErasureRuntimeFence({initialize:true,...})` в
отдельном admitted storage, подтверждает CLOSED/sequence-1/no owner/leases0, затем
закрывает connection. Никакого SQL schema imitation или initialization из runtime.
Для дальнейшего boot constructor без initialize — уже существующая exact control DB.
Все участники смотрят на ТОТ ЖЕ underlying host storage, не на отдельные Docker copies.

| Runtime-only env | Значение / источник |
| --- | --- |
| `DEPLOY_ENV` / `ERASURE_SCOPE` | `staging` / `canary` |
| `ERASURE_FENCING_ENABLED` | `true`, не build/preview |
| `ERASURE_FENCE_DIRECTORY` | exact path из protected REQUIRED record |
| `ERASURE_VERIFICATION_KEYS_FILE` | bound0600 file в ro keys mount; public signing + retained secret HMAC generations |
| `ERASURE_REMOTE_READ_URL` | independently qualified HTTPS `/v1/erasure/read`, без query/userinfo/redirect |
| `ERASURE_READ_TOKEN` | existing approved private channel, ≥32chars; value никогда не в journal/CI/argv |
| `COMMERCE_V2_FOUNDATION_MODE` | `false` |
| `PAYMENT_MODE` / `MARKETING_BROADCASTS_ENABLED` | `disabled` / `false` |

Runtime НЕ получает signer, privileged S3 keys или age identity. Прочие env сохранять
по fingerprint, проверить отсутствие фактических preview copies через API + DB.
Missing/corrupt/writable mount tests делать в отдельной lane, не удаляя live marker.

#### 3. Offline changed-state proof до canary replacement

Взять точный ранее qualified encrypted canary archive, SHA/size/source facts и все
retained runtime keys. Restore в отдельный private volume, никаких provider/mail/jobs.
Ни archive, ни working merchant/editorial volumes, ни newest fence/ledger не менять.

1. Read-only baseline: integrity/FKs/lineage + migration ledger. В isolated copy
   trusted exact-source `migrateV2()` применяет только отсутствующие reviewed migrations:
   0023 consent_attribution, 0024 course_commercial_control, 0025 authenticated_consent_events.
   Unknown lineage/schema → STOP. Нет migration26 от #204/#205.
2. Проверить full DDL fingerprint
   `158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030` из reviewed code;
   expected hash никогда не вычислять из candidate как новое значение допуска.
3. Изолированная test identity/queued outbox/session/consents + backup BEFORE deletion
   допустимы только как явно tagged failure fixture, не CMS course/legal release или
   evidence реального browser consent. Авторство настоящего request отдельно проверяет
   trusted Better Auth session adapter; fixture не делает operational transport PASS.
4. Publish подтверждённый test erasure, затем restore старой copy; запросить NEW remote
   nonce checkpoint, `applyIsolatedRestoreErasure()`, подтвердить отсутствие target
   account/consents/outbox, suppression, невозможность старого login/session/marketing.
   New same-email identity не присваивает прежние согласия и не снимает suppression.
5. Повторить admission через настоящий runtime boot/fence на isolated restored copy,
   не только library receipt. Missing/stale/forked ledger, dropped generation, lost
   mount, false/missing flag/foundation → nonzero/CLOSED до traffic/timers.
6. Merchant restore НЕ откатывает independent applied prefix/owner installation.
   Сохранить cipher evidence, journal и integrity/count results без raw identity.

**RECOVERY_PASS:** old-backup resurrection отвергнута на actual current artifact и
installed authority; original backup остаётся доказанной исторической копией.
Это не утверждение уничтожения всех offline копий/processor данных.

#### 4. Exclusive migration и controlled normal-canary replacement

Только после Gate0/CUSTODY/RECOVERY и execution GO. Сохранить текущий encrypted online
snapshot и его remote hash, не повторяя unrelated foundation qualification.
Остановить canary write-capable processes; запретить new jobs/overlapping deployment.
Readonly backup reader не считается writer, но его raw archive не разрешён к traffic
без fresh-ledger apply. Production backups продолжают работать без изменений.

Standalone migrate и automatic server startup migrations НЕ lease-protected.
Допускаются только при independently confirmed zero competing writable mounts/processes.
Не использовать rolling old/new overlap: старый unfenced image не имеет защиты даже
если делит volume. Coolify/controller replacement semantics проверить заранее; если
exclusive stop/replacement не обеспечен штатно — HOLD, не custom command bypass.
Migration failure → сохранить journal; restore отдельной copy с newest ledger, не
down-migration, reverse SQL или overwrite original volume.

Deploy exact admitted source только существующим normal-canary controller; одна
постановка deployment, ambiguous result → GET/status reconciliation. Source/controller
identity отдельны. Read-back: actual image/digest, baked SHA, mounts/UID/kernel ro,
runtime-only secrets presence, 0preview, no public exposure; `/readyz` требует
`erasure:qualified`, scope и реальную fresh authority. `/identity` отдельно от readiness.
Проверить LAB/Admin/Platform private upstream DNS после Commerce replacement; не
предполагать устойчивость timestamp container name. Production fingerprints,
403 guards и backup freshness подтвердить независимо.

#### 5. All-writer / failure admission, не публичный launch

В явно изолированной lane проверить реальные REQUEST, Better Auth hooks/auth-email,
campaign WORKER/SEND и controlled owner process через shared fence. Marketing timer
остаётся false, Refref payment/refund rail disabled; тест worker вызывается controlled
driver с bounded sink, не включением production-like рассылки. Payload jobs/manual
Local API и editorial mutations остаются CLOSED до собственного admission.

- Shared lease на async request/worker/send → drain отказ ДО remote publish/purge.
- Второй independently booted участник делит тот же control storage; missing/different
  fence/registry или unfenced old writer → admission HOLD. Инвентаризация OS/mounts
  обязательна: нельзя доказать защиту произвольного SQL только API-тестом.
- Crash/lost send response → durable ACTIVE/UNKNOWN и CLOSED; no timeout release,
  no blind re-send. Проверить, что auth error swallowing не стирает SEND evidence.
- Authority outage/change/rollback/fork → readiness/request refusal; восстановление
  связи само по себе не reopen. Нужен новый qualified boot/admission без reset prefix.
- Verified erasure получает fresh genuine Better Auth capability; Origin/account
  binding перепроверяются до publication и после drain. Stale/unverified email case
  в art@ остаётся PENDING_IDENTITY_VERIFICATION. JSON «capability» не принимается.
- Actual owner admission: drain → custody ACK → purge/revoke → verified application
  receipt → newest-head equality → reopen. processor/archive disposition PENDING
  сохраняются честно; unrelated LIVE sessions не удаляются, restored credentials — да.

**ALL_WRITER_PASS** требует complete mounted/process inventory + доказанные leases и
отсутствие неподконтрольных writers. **PRIVATE_CANARY_ERASURE_QUALIFIED** только при
CUSTODY_PASS + RECOVERY_PASS + ALL_WRITER_PASS + current runtime/security read-back.
Public ingress/legal release/content authoring/registration по-прежнему CLOSED.

#### STOP/HOLD и recovery вместо небезопасного rollback

| Состояние | Разрешённое поведение |
| --- | --- |
| До current canary replacement | Отменить pending execution; сохранить baseline runtime/volumes, новые isolated evidence и private journal; нет cleanup чужих ресурсов |
| REQUIRED установлен / signed event опубликован | Сохранить marker, highest prefix, keys, ledger и ciphertext; остановить participating writers, CLOSED. Не запускать older unfenced image и не переходить NEVER_INSTALLED |
| Remote PUT/COMMIT/ACK неопределён | STOP, GET-only same request/head/packet reconciliation; no new requestId/PUT/re-encryption. `publishPending()` — отдельный явный owner repair после доказанного state, не автоматический retry |
| Unknown SEND/owner claim/crash | Не очищать leases/owner SQL или TTL; independent provider/operation reconciliation и reviewed owner recovery procedure до reopen |
| Migration/schema/identity/mount/IAM drift | Сохранить evidence, не чинить молча. Canonical restored copy + newest complete ledger + exact compatible artifact; отсутствие поддержки безопасного recovery — HOLD |
| Потеря read authority/keys/current ledger | Никакого saved checkpoint/empty genesis fallback; CLOSED до восстановления независимой newest authority/key custody |

Для каждого gate journal содержит enum результата, source/controller/image identities,
resource IDs, permissions/mount fingerprints, schema/ledger hashes, safe counts и
evidence locations. Никаких PII/token/secret bytes. Source snapshot до migration и
current custody не удаляются как «временные» после неуспешной попытки.

#### Следующий Stage A E2E — ART-179, отдельный функциональный admission

После erasure qualification подготовить controlled private browser access при
сохранении внешних 403 и без public registration. Exact owner-approved legal bytes
с versions/hashes должны получить отдельный activation admission; review/approval
не подменяют active release. Один настоящий курс вручную создаётся в Payload с
реальными Kinescope IDs/правами: никаких синтетических course/legal facts.

Проверить CMS→Commerce FREE, verified email/NotiSend/SmartCaptcha, unchecked separate
consents, secure host-only cookies, session persistence/logout/revocation, required
server gates, FREE entitlement и protected playback. Недоставленное письмо или
неупражнённый browser/video path не получают PASS из `configured`/API-only результата.
Маркетинг/PAID/payment/refund/F9 и production остаются вне этого canary admission.

ART-232 хранит custody/erasure/processor gates, ART-179 — auth/E2E, ART-41 — cutover
readiness. 0new issues, no Done transitions. План доступен для review; операционные
bindings, launchers и permissions пока не квалифицированы, execution не начат.
