# Общая интеграция LMS/LAB → Refref v10

Независимая редакция SOL, 27.10.2026. Статус: документационный проект для review. Осмотрены исходники Flexperiment `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; нормативный upstream — Refref `c932b656edbda1d47cfb57de08fd4a36536712f5` из [PR #130](https://github.com/ArtGurianov/refref/pull/130). Ветка/PR Refref не выдаются за установленный transport. Материалы OPUS не использованы.

Профили: [LMS](02-lms-profile.md), [LAB](03-lab-profile.md). Общая архитектура — [01](01-commerce-architecture.md), миграция/приёмка — [06](06-migration-and-e2e.md). Названия новых записей Flexperiment ниже — предложения к реализации, не существующие публичные routes.

## 1. Разделение платёжного владельца и реферального адаптера

| Наблюдаемый источник на baseline | Что делает сейчас | Новый профиль v10 |
|---|---|---|
| [payment-mode.ts](../commerce-v2/src/payment-mode.ts) | `disabled/mock/refref`; production запрещает mock; Refref-mode требует scoped config и protected delivery | Добавить отдельно квалифицированный merchant-native payment profile и отдельный Refref reporting adapter. Старый enum/ключ не переименовать как доказательство готовности |
| [refref-payment-rail.ts](../commerce-v2/src/refref-payment-rail.ts) | RC.2 resolution → checkout-attempt → `obligations/full/payment-session`; читает attempt как платёжную истину, исполняет full-only refund через Refref | Для новых v10-покупок деньги/сессии/возвраты принадлежат Flexperiment; Refref хранит BOUND, результаты, C и дела. Старые attempt обслуживаются своим прежним владельцем |
| [checkout-snapshot.ts](../commerce-v2/src/checkout-snapshot.ts) | `refref.shared-checkout-snapshot/2`, один `full` ORCHESTRATED obligation, fiscal items внутри | Не пересылать старый платёжный snapshot как новый merchant-result. Сохранить его для старых заказов; новый результат имеет свой versioned contract |
| [checkout.ts](../commerce-v2/src/checkout.ts), `applyProjection` | Сверяет суммы/hash, при PAID транзакционно выдаёт LMS entitlement или LAB ticket | Native provider truth запускает нужное действие Flexperiment; отсутствие Refref ACK не вызывает повтор платежа/повтор доступа. Исходный FULL и факт доступа/билета — разные записи |
| [refunds.ts](../commerce-v2/src/refunds.ts) | Решение потребительского возврата отдельно от исполнения; sealed envelope, read-back, `REFUND_FULL_ONLY`, отзыв entitlement по подтверждённому возврату | Перенести гарантии на выбранный merchant provider; не считать текущий full-only path допуском частичных возвратов или новым правом Refref распоряжаться деньгами |

Этот проект не выбирает банк, ККТ, полномочия/креденшалы и способ их выдачи. Закрытый тестовый маршрут Flexperiment → Refref → Точка не доказывает merchant-native authority Flexperiment. Не требуются восстановление Agent Referrals V1, новый кошелёк покупателя или копия финансового ledger Refref.

## 2. Переход Arrival/кодов

В отличие от Mikluha, [browser-context.ts](../commerce-v2/src/browser-context.ts) и [миграция0034](../commerce-v2/migrations/0034_browser_contexts.sql) сохраняют context/Arrival в **SQLite**. [app.ts](../commerce-v2/src/app.ts) на новом checkout-preview реально вызывает `deliveryForBuy`; результат с `browserContextId`/`deliveryDegraded` замораживается в intent. Повтор intent использует прежний context. Это существующая ADR-139 подготовка, не v10 BOUND.

- Отдельные host-scoped cookies `__Host-flx-ctx-lms` и `__Host-flx-ctx-lab`; default lifetime 30 дней, допустимый конфигурационный диапазон 1–400 дней. Cookie/context — локатор контекста, **не** право на такое же окно реферальной атрибуции.
- Raw proof сохраняется временно в SQLite до30 минут и очищается после окончания; Buy тратит до1500мс и может продолжить прежний resolution с `deliveryDegraded`. Нельзя перенести этот fallback на неизвестный исход v10 `binding.create`.
- LMS logout/account switch ротирует context; pending proof не переносится в новый account. LAB guest capability/контакт не становится Refref buyer identity. Scope origin/context и защита от межвитринного использования сохраняются.
- Старый Arrival receipt/cookie не автоматически создаёт v10 touch, дату защиты, BOUND или новый referral right. Для уже приобретённого права нужна квалифицированная карта перехода; без неё старый профиль завершается как старый, новое право возникает из допустимого действия v10.

В v10 один активный holder, без очереди. Refref возвращает `touchRef`, версии, `protectedUntil` и `attributionExpiresAt`: защита72ч и campaign TTL для нового BOUND (default7, максимум30 календарных дней) отличаются от жизни cookie. Refresh/retry не продлевают их. Пока72ч не истекли, конфликтный link/promo не перехватывает holder; позже при ещё действующем holder смена требует R14.1 — показ актуальной пары предложений и scoped confirmation с версией. Истечение touch не прекращает право уже BOUND покупки.

Допустимые действия: `REFERRAL_NAVIGATION` или `PROMO_APPLY`. Для последнего — `actionVariant=APPLY_BUTTON` либо квалифицированный `ORDER_SUBMIT`: видимый код, ясный смысл применения при сознательном оформлении, серверная проверка intent/code/scope. SDK prefill/edit/background-save не создают touch и сами скидку не применяют. Подтверждённый link и сохранённое допустимое AutoApply не требуют нового Apply; обещанная цена не снимается. Merchant promotion и referrer promo различаются: старый `checkoutCode`/prefix не служат доказательством Refref holder.

## 3. Первоначальный BOUND и команды

Применяются [канонический BOUND](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/02-attribution-bound.md) и [карта API](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/06-api-and-states.md).

1. Создать устойчивую экономическую `purchaseRef`/договорную ревизию; проверить существующие legal, account/guest, price/seat и storefront admission. Предварительная оценка условий не расходует touch и не создаёт BOUND.
2. Для реферального пути закрыть **все первые платёжные возможности**, включая счёт, payment URL, provider session и создаваемую банковскую операцию. Получить durable BOUND до их открытия, а не только до банковского callback.
3. При lost ACK сохранить command/key/body и прочитать `GET /v10/bindings/by-command/{commandId}` — включая прежний отказ. UNKNOWN не объявлять отказом и не обходить новым purchaseRef/обычным checkout. При установленном отсутствии BOUND возможен прозрачный обычный checkout без ретроатрибуции и с исполнением обещанной цены.
4. После BOUND создавать merchant-native оплату. Нет BOUND — нет реферальной C; применённая скидка сама это условие не заменяет. Для новых ordinary/free-путей BOUND не является универсальным условием работы Flexperiment.

| Команда/ресурс Refref | Применение Flexperiment | Ограничение |
|---|---|---|
| `POST /v10/touches`, switch-confirmations | Проверенное действие на своей витрине, версия holder/предложений | Browser не назначает партнёра/eligible set |
| `POST /v10/bindings`, read-by-command | Business/purchase/revision/cart, offer proof, **fullPaymentDueAt**, finality mode/frozen anchor | Один consumed touch, не более одного BOUND/партнёра/исходной C на покупку |
| `POST /v10/purchases/{purchaseRef}/revisions` | Сообщение локально принятой договорной ревизии до первого FULL | CAS Refref-проекции, не разрешение заключить/изменить договор Flexperiment |
| `POST /v10/purchases/{purchaseRef}/results` | Append-only `PAID_IN_FULL`/`NOT_PAID`/применимый `CANCELLED` | **Без expectedVersion**; технический отказ не равен экономической непригодности |
| `GET /v10/commands/{commandId}` | Квитанция и текущая обработка прежней команды | Не создаёт повторный платёж или новое окно |
| `POST /v10/evidence` | Поздний конкретный контекст/материал по sourceReceipt и subject | Доступ/связь проверяются; файл/хеш не независимый банк-факт |

`fullPaymentDueAt` обязателен и для одноразовой100% покупки: срок задаёт выбранный checkout-profile, а не arbitrary now/жизнь cookie. Для нового LAB-профиля с частичными взносами такая возможность допустима лишь после отдельного коммерческого решения; обязательная предоплата Mikluha **не** становится политикой LAB или LMS. Режим PAYMENT/SCHEDULED_SERVICE и конкретный service anchor выбираются/публикуются в условиях до BOUND; произвольного default от типа продукта или fiscal tag нет.

## 4. Ревизии договора и денежная хронология

После сохранённого BOUND Flexperiment самостоятельно принимает изменения по согласию, доступности услуги/мест и денежным ограничениям. В одной локальной транзакции — новая immutable revision/effective time/acceptance, allocations и outbox. Refref квалифицирует реферальную пригодность отдельно; отказ/UNKNOWN этой команды **не** откатывает договор/депозит, не блокирует безопасную доплату и не удаляет BOUND/партнёра. Это существующее R6.2/CW-022: обычная продажа неподходящей ревизии возможна без ложного обещания награды.

Два UNKNOWN не смешиваются: неизвестный первоначальный BOUND блокирует первое referral-инициирование; неизвестная обработка поздней ревизии такого общего запрета не даёт. Реальная BANK_UNKNOWN операции при любом сценарии запрещает пересекающийся новый платёж/безосновательное освобождение места. Внешний платёж не держит SQL-lock во время сети; dispatch/read-back используют устойчивые operation IDs, fingerprint и connection/owner scope.

Первый истинный FULL относится к эффективной договорной ревизии **в момент фактического полного исполнения**, не к последней записи UI/ACK. Если старый платёж завершил FULL вT1, ревизия вступила вT2, callback пришёл вT3, гдеT1<T2<T3, хранить FULL по ревизииT1. Поздний ACK старой revision не откатывает новую принятую версию. При снижении цены до ранее уплаченной суммы первый FULL может возникнуть при вступлении новой ревизии; он не датируется задним числом первым взносом.

После первого действительного FULL C не увеличивается/не пересчитывается из-за добавленного товара, LAB участника, новой редакции курса или доплаты; сохраняются исходные purchase/BOUND/партнёр и S5 anchor. Согласованное продолжение не становится новой покупкой от технического ID или полного refund/recharge. Настоящая самостоятельная покупка требует нового действия и BOUND до её первой оплаты. Получение доступа/билета и фактическая оказанная услуга управляются Flexperiment отдельно, не FINAL.

## 5. Деньги и обязательный FULL-отчёт

| Величина | Правило |
|---|---|
| `G` | Сумма подходящих line totals после собственных скидок Flexperiment, до Refref-скидки; без неподходящих услуг/доставки |
| `D_rule` | Расчётная Refref скидка frozen terms, percentage floor; сервер Refref рассчитывает сам |
| `D_applied` | Фактически предоставленная скидка, включая фактическое округление; её цена исполняется перед покупателем |
| `C` | Purchase-level FIXED либо PERCENT отG с half-up, gross RUB; одна исходная C |
| Первоначальный guard | Прямое `G−D_rule−C>0` на фактической FULL-ревизии; `G≥P_min` не эквивалентен ему |

OWNER-02: отсутствие использования скидки при выполненных attribution/eligibility guards не лишает партнёра C. `D_applied=0` не обнуляет D_rule и не квалифицирует неподходящую экономику. Скидка без допустимого touch/BOUND до первой возможности оплаты не даёт C. Расхождение округления фактической цены не пересчитывает C; денежный snapshot/S4 использует реальные поступления и D_applied.

Отчёт только по BOUND: FULL — исторически полностью исполненная денежная обязанность, а не redirect, чек, entitlement/ticket, одобрение кредита или незавершённый внутренний зачёт. NOT_PAID может иметь `prepaymentReceived=true`; при реальном неизвестном исходе нужна диагностика, а не ложное утверждение отсутствия денег. CANCELLED применим до истинного FULL; после него customer refund не маскируется этим результатом. Органические покупки и постоянный поток каждого взноса/возврата Refref не требуются.

В локальной транзакции действительного результата сохранить source fact и outbox. Вход — строго [merchant-result.schema.json](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/merchant-result.schema.json):

- `schemaVersion=refref-v10.merchant-result/1`, commandId/idempotencyKey, Business/binding/purchase/revisionRef/hash, sourceEventRef/sourceVersion;
- `revisionHash` —64 lowercase hex без нынешнего `refref-jcs-1:` prefix; sourceVersion/money — safe integers;
- result/stateAsOf/knownAt/timePrecision/sourceProvenance; обычный sender — MERCHANT_ATTESTED;
- FULL: `actualPaidInFullAt`, полный собственный purchaseSnapshot эффективной ревизии, стабильные строки/quantity, цены/критерии и фактические applied-скидки. `buyerDiscountApplied` — boolean факта цены, не proof Apply; false требует нулевые applied-суммы, true допускает округлённый0;
- receipt/actor/qualifiedAt/commissionAmount не назначаются отправителем. Покупательские email, account IDs, guest capability, имена и полные выписки не уходят в обычный payload/notes.

Срок FULL — не позднее конца следующего российского рабочего дня **после фактической полной оплаты**, не произвольно позднего knownAt. Даты исполнения, знание, source/received/qualified times раздельны. К fullPaymentDueAt получить достоверное состояние/применимый результат; уточнение отчётности не прекращает право по BOUND. Поздние истинные FULL и прежние своевременные претензии не теряются из-за порядка доставки; точная R17.1/mixed-fault функция остаётся профильным gate.

## 6. FULL до регистрации ревизии: заданный транспортный контракт

[Канонический reporting §3.1](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/03-merchant-reporting.md) задаёт durable приём валидного FULL по ещё неизвестной или экономически неподходящей ревизии. Это не открытое денежное решение:

1. `POST .../results` сохраняет факт/снимок и возвращает HTTP202 с immutable `sourceReceipt`. Предварительный положительный CAS ревизии не является prerequisite.
2. Собственный достаточный FULL snapshot квалифицируется по frozen terms. При непригодности факт сохраняется без положительной C, BOUND не удаляется; это не S4-обнуление существующей C. Если недостаёт конкретного контекста эффективности/хронологии, факт остаётся pending с причиной.
3. Через `GET /v10/commands/{commandId}` читать `processingStatus=ACCEPTED_FOR_PROCESSING` либо `APPLIED`. Последнее означает завершённую проверку, **не** гарантированную C или независимую банковскую верификацию. Pending после receipt не является неоплаченным заказом.
4. Поздний контекст направляется существующим `POST /v10/evidence` с matching Business/BOUND/purchase/sourceEvent/revision/hash и ссылкой на receipt; evidenceRef связывается с тем же фактом. Не переписывать snapshot, исходный receivedAt или actualPaidInFullAt и не делать поздний CAS условием сохранения FULL.
5. `requestFingerprint` включает transport identity; `sourceFactFingerprint` исключает commandId/idempotencyKey. Та же source identity/содержание под другой командой связывается с прежним фактом, без второй C/нового времени факта. Изменённый body старого key — IDEMPOTENCY_CONFLICT; несовместимое содержание прежнего source ID — SOURCE_EVENT_CONFLICT, без overwrite. Auth/schema/scope реальные ошибки сохраняются; один неизвестный hash не превращается в VERSION_CONFLICT/PROFILE_NOT_QUALIFIED.

Replay/history recovery обязаны работать после restart/backup без копирования текущей последней цены вместо исторической. Неопределённость квалификации не выдают партнёру как подтверждённый отказ или обещанную награду. Реальный transport/source conformance этих правил — обязательный допуск, не результат чтения документа.

## 7. Возврат покупателю, комиссия и выплаты партнёру

Customer refund исполняет Flexperiment по своим обязательствам. S4 не разрешает/не запрещает его и не управляет доступом/билетом. Если Flexperiment хочет полностью обнулить C, подаёт S4 с полным относимым денежным/отменным evidence snapshot, а не отправляет постоянный refund stream. Итог только исходная C либо0; B2 отдельно исправляет ложный первоначальный FULL. Отдельный технический номер/сертификат не доказывает полное прекращение; при согласованном продолжении сохраняются все относимые доплаты/возвраты. Один банковский refund без распределения не доказывает eligible scope.

Все основания, сроки и окончательность — [денежный контракт Refref](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/04-money-finality-claims.md). После окончательного обнуления новый платёж/FULL автоматически C не восстанавливает. Допустимый RESTORE_FULL исполняется по той же исходной C и корректирующему реестру, с учётом уже выплаченного/UNKNOWN scope — не новый банковский перевод по числу сообщений.

Flexperiment самостоятельно платит партнёру по месячному реестру, сообщает исполнение/неоплаченный или неясный остаток/исправления, отвечает на надлежащий запрос при споре. Номер реестра связывается с назначением. Месяц FINAL, исходный срок, допустимые препятствия/O6 и восстановленные суммы/O7 применяются строго по [каноническому контракту выплат](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/05-payouts-s3-conformance.md). Merchant report, сообщение партнёра и bank fact различны; отсутствие отчёта/закрытие S3 не гасят долг и не разрешают повтор UNKNOWN перевода. В Flexperiment не строится своя модераторская/банковская машина Refref.

## 8. Допуск реализации

До реферальных продаж: действующий v10 API/auth/scope, BOUND-before-opportunity, replay и refusal/UNKNOWN, native acquiring/fiscal/refund ownership и read-back, автоматический source/outbox sender, actual FULL/revision chronology, календарь/R17.1, buyer/legal/PD-admission, точные профильные finality mode/anchor/due. Сохраняются ordinary/free доступ и обслуживание старых прав в их допустимом scope. SOURCE/contract, served transport и provider/evidence E2E получают отдельные verdict. Публичный GO Refref требует LMS, LAB и Mikluha; ни этот проект, ни mock/reference PASS их не заменяют.
