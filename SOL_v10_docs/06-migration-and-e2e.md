# Переход LAB/LMS на v10 и программа приёмки SOL

Дата:27.10.2026. Статус: проект после разрешённой сверки, **все новые E2E NOT_RUN**. Исходный Flexperiment main `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; нормативный Refref `c932b656edbda1d47cfb57de08fd4a36536712f5`. Первоначальный пакет независим; эта редакция включает замечания GPT/OPUS и согласованные уточнения сравнения. Это план последующей реализации, не выполненная миграция или разрешение на деньги.

## 1. Сохраняемая история

| Область | Наблюдаемый источник | Стратегия |
|---|---|---|
| V2 storage/migration | [db.ts](../commerce-v2/src/db.ts), [migration-integrity](../commerce-v2/src/migration-integrity.ts), [lock](../commerce-v2/migrations/migration.lock) | SQLite/WAL, новая forward suffix после35 SQL. Прежние SQL, порядок и hash записей неизменны; journal не reset |
| Legal/fiscal/order snapshots | [0011](../commerce-v2/migrations/0011_canonical_order_snapshots.sql), [0017](../commerce-v2/migrations/0017_fiscal_policy.sql), [0027](../commerce-v2/migrations/0027_owner_legal_decisions.sql) | Сохранить действительные accepted bytes/hash, квалификацию и OwnerLegalDecision; новая ревизия не переписывает старый акцепт |
| V2 RC.2 payment/refund | [rail](../commerce-v2/src/refref-payment-rail.ts), [refunds](../commerce-v2/src/refunds.ts) | Операции имеют прежний owner/flow до доказанного завершения; нового native create на их UNKNOWN scope нет |
| Intent/места/Arrival/stop | Миграции0030–0035 и [checkout](../commerce-v2/src/checkout.ts) | Удержания, исходные сроки и контексты инвентаризируются; новый профиль не считает старый cookie BOUND |
| Access/tickets | [entitlements](../commerce-v2/src/entitlements.ts), [LAB tickets](../commerce-v2/src/lab-tickets.ts) | Реальные grants и билеты не переиздаются как новая продажа; срок/объём прав не определяется C/FINAL |
| Restore/erasure | [restore-reconciliation](../commerce-v2/src/restore-reconciliation.ts), [erasure-restore](../commerce-v2/src/erasure-restore.ts) | Сохранять независимый inventory, tombstone/fence, source identity и проверку схемы. Новый adapter требует новой qualified recovery, старый Refref reader не читает native банк автоматически |
| Retired V1 | [AGENTS](../AGENTS.md), [retirement evidence index](../docs/evidence/2026-10-16-lab-v1-retirement/README.md) | Не возобновлять V1/runtime/routes, не использовать его архив как backfill новых V2 orders. Исторические случаи — отдельно разрешённый recovery в архивном scope |

В исходном main **нет0036**; номера будущих SQL не резервируются этим документом. Выводы и исправления незамерженных веток/PR не считаются частью baseline. Перед реализацией заново вычислить фактический suffix, проверить соответствие решениям и точные SHA зависимостей.

## 2. Инвентаризация до реального cutover

Начать на отдельном изолированном локальном стенде с синтетическими данными. Реальный read-only inventory — отдельное разрешённое действие, не скрытая часть этого PR. Нужны:

1. Source/digest/schema identity сред, применённый journal и prefix, actual stop/readiness/admission, соответствие buyer documents/акцептов. Main не является deployment source автоматически.
2. Действительные V2 attempts/intents/payment URLs, CREATE_UNKNOWN/REVIEW_REQUIRED, непрочитанные успехи, refunds/envelopes, фискальные задания и доступность каждого прежнего source/owner.
3. Покупательские договоры, BOUND/C/claims/реестры, если они реально существуют, и выданные LMS grants/LAB holds/tickets/use; никакой выдуманной нулевой истории из факта MONEY HOLD.
4. Контрольные числа: платежи/возвраты/UNKNOWN суммы, grants, tickets/occupied capacity, pending outboxes. Отдельно scope без установленных allocations; суммы не подгонять для закрытия баланса.
5. Restore/custody/erasure evidence и действия, которые нельзя повторить после старого backup. Нужен независимый inventory потерянных после backup заказов: query текущей SQLite не способен перечислить уже потерянные записи.

Результат хранится приватно с hashes/source times/authority и агрегированными результатами без ПД. Реальные выгрузки, токены/ключи и provider payload не попадают в публичный Git/PR или иностранный CI.

## 3. Последовательная реализация

| Этап | Ограниченный результат | Выходное доказательство |
|---|---|---|
| S0 — review SOL и последующее сравнение | Собственный пакет и перечень FX-C01–11; закрытые Refref O1–O7 не переоткрываются | Принята общая после сравнения редакция, а не две конкурирующие спецификации |
| S1 — profile admission | Business/origin/campaign mapping, due/finality, native provider scope, актуальные документы/фискальный mapping | Конкретные поддержанные потоки, исходы UNKNOWN и источники; никаких новых чисел/полномочий от разработчика |
| S2 — storage/ownership | Forward-only purchase/revision/operation/allocation/outbox facts; immutable прошлые договоры | Migration tests, direct-SQL/NULL/wrong-type guards, prefix integrity, rollback-compatible readers |
| S3 — synthetic source/contract | Отдельные acquiring и referral adapters, BOUND gate, grant/ticket, UNKNOWN/replay, ревизии и refunds | Exact-head unit/DB/concurrent tests; заявлен только source/contract scope |
| S4 — первый работающий профиль | Один из LMS/LAB по выбранному порядку; минимальный native paid flow, без обязательной SDK или новой корзины | Authenticated transport обеих систем, restart/recovery, durable FULL receipt/qualification; второй профиль не объявлен проверенным автоматически |
| S5 — второй профиль и profile edge cases | Отдельная полноценная проверка доступа LMS/мест/гостей LAB | Разные profile evidence, действительный origin scope, переносы/возвраты и схемы чеков |
| S6 — provider/evidence и rehearsal | Отдельно разрешённый native acquiring/refund/fiscal source; isolated restore/replay и cutover rehearsal | Независимый read-back, квалифицированный scope, сохранённая история/контрольные суммы; mock не provider PASS |
| S7 — scoped cutover | После явной authority: новые V2 покупки назначаются v10/native profile атомарно | Source/digest/schema/policy/campaign/stop evidence, обслуживаются прежние обязательства |
| S8 — retirement старой V2 выдачи | Удаление лишних writers только после завершения tails и проверки retention | Нет orphan operations/прав; отдельный source/deploy review. Не перезапуск V1 |

Сначала один профиль, затем другой — технический порядок, не освобождение от обоих E2E перед публичным Refref GO. Полная LMS/LAB/Mikluha qualification обязательна для публичного Refref v10; независимый бесплатный доступ Stage A не должен ждать финансового запуска другой системы.

## 4. Ownership и безопасный rollback

Старый V2 RC.2 и новый v10/native paths маршрутизируются по сохранённому profile/operation owner, не по текущему env. Во время cutover ни один order/денежный scope не получает двух writers. Старые payment URLs должны быть либо доказанно прекращены исходным owner, либо учтены как реальные возможности позднего исполнения. Просто спрятать кнопку недостаточно.

| Сбой/точка | Допустимое восстановление | Что запрещено |
|---|---|---|
| До новых обещаний | Остановить новую выдачу, вернуть квалифицированный совместимый runtime | Down/reset применённой схемы/журнала |
| После saved BOUND | Приостановить новые покупки, сохранить существующие цену/договор/операции/reporting/readback | Выключить весь v10 adapter/API и потерять прежнее право |
| Native BANK_UNKNOWN | Read-back по прежней operation identity, адресный fence суммы/мест | Новый key/owner и второе списание; TTL как доказательство отсутствия денег |
| Refref BOUND UNKNOWN | Перечитать исходный command/result до первой referral payment opportunity | Degraded/таймаут как отрицательный ответ и ретроBOUND после оплаты |
| Refref revision/reporting outage после BOUND | Исполнить допустимые договор/доступ/билет, сохранить source facts/outbox, доставить позже | Откатывать договор, блокировать безопасную доплату или повторять деньги из-за нет ACK |
| Backup старше внешнего outcome | Независимый inventory и native/legacy owner read-back перед side effects; erasure tombstones повторно применены | По откатившемуся marker повторить оплату/refund/чек или восстановить удалённый subject |

Новые поля и schema allowlists должны быть включены в backup/retention/restore admission. Нельзя просто удалить проверку fingerprint ради новой схемы; исторические allowlists сохраняются в их scope. Внешние credentials/custody не добавляются этим PR; будущий deployment описывает их отдельно.

## 5. Программа приёмки — 80 сценариев NOT_RUN

Evidence каждого выполненного случая: exact source SHA Flexperiment/Refref/adapter, schema/terms/calendar/profile versions, source IDs и безопасные receipt hashes, фактическая HTTP/DB/outbox хронология, деньги/места/grants before/after. Все fixtures синтетические, пока provider operation не разрешена отдельно. Одни ID и тексты ниже не являются выполненными тестами.

### Общие проверки

| ID | Сценарий | Проверяемый результат |
|---|---|---|
| FX10-COM-001 | Valid action → BOUND → native полная оплата → FULL | BOUND до invoice/link/session, один денежный факт, одна исходная C; исполнение профиля независимо от receipt |
| FX10-COM-002 | Durable BOUND, ACK потерян | Та же команда/read-back, gate закрыт до результата; не новый purchaseRef/партнёр |
| FX10-COM-003 | Referral BOUND UNKNOWN, UI получил deliveryDegraded | Нельзя трактовать таймаут как отказ, открыть первую referral оплату или обещать ретроатрибуцию |
| FX10-COM-004 | Органическая платная покупка/бесплатный доступ | Исполняются собственные обязанности; без BOUND не создаются C/обязательный organic report |
| FX10-COM-005 | Скидка применена, действительной атрибуции нет | Нет BOUND/C; все остальные денежные guards положительны; скидка сама право не создаёт |
| FX10-COM-006 | Действительный touch, BOUND пытаются создать после первой payment opportunity | Отказ в новом праве, без скрытого backdate/нового purchase identity |
| FX10-COM-007 | Действительные attribution/BOUND, покупатель не использовал скидку | OWNER-02: применение скидки не отдельный guard; D_rule остаётся расчётной, C от G |
| FX10-COM-008 | G−D_rule−C≤0, но D_applied=0 или округлена иначе | Неподходящая ревизия не получает C за счёт подстановки actual discount; обещанная цена сохраняется |
| FX10-COM-009 | SDK prefill/edit без Apply/квалифицированного submit | Нет нового promo-touch; независимые link/AutoApply и прежний holder сохраняются |
| FX10-COM-010 | Квалифицированный ORDER_SUBMIT без отдельной Apply | Видимый код/ясный intent/server validation; v10 touch/BOUND до оплаты. Скрытый код не проходит |
| FX10-COM-011 | Конфликтный link/promo в72h защиты | Holder не перехвачен, retry/cookie refresh не продлевает срок; нет очереди проигравших |
| FX10-COM-012 | Защита истекла, прежний touch пригоден, buyer switch | Без R14.1 смены нет; current versions/offer pair проверены, stale confirmation конфликтует |
| FX10-COM-013 | Cookie жив, campaign touch TTL истёк; отдельный fixture TTL>30 | Нет нового BOUND, недопустимый TTL не принят. Доплата уже BOUND не теряет право |
| FX10-COM-014 | LMS logout/account switch либо LAB context на другом origin | Нет переноса pending proof/приписывания чужого holder по email/account; scopes раздельны |
| FX10-COM-015 | Native create timeout после возможного dispatch | Реальный UNKNOWN/тот же operation/key; ни второго create, ни автоматического FAILED |
| FX10-COM-016 | Дубли callback/read-back, параллельные workers/restart | Одна allocation/покупательская обязанность/исполнение; реальные разные списания не маскируются webhook dedup |
| FX10-COM-017 | Redirect success, чек, кредит одобрен или внутренний сертификат без исполненных денег | Нет ложного FULL/C; сохранить неизвестность/неисполненный остаток |
| FX10-COM-018 | Local merchant revision принята, Refref недоступен/отказал по пригодности | Договор/безопасная оплата не ждут ACK; BOUND/история остаются. Экономический отказ не S4-zero |
| FX10-COM-019 | FULL с достаточным собственным snapshot, ревизия ещё не CAS-зарегистрирована | Durable202/sourceReceipt; квалификация по собственному снимку, не REVISION_UNKNOWN отказ |
| FX10-COM-020 | FULL экономически неподходящей реальной ревизии | Факт сохраняется, APPLIED не означает положительную C; BOUND не удалён |
| FX10-COM-021 | FULL принят, конкретного effective контекста не хватает; позже evidence | Pending receipt не C/0; `/v10/evidence` связан с исходным subject. Исходные времена/hash/windows не изменены |
| FX10-COM-022 | Старый revision ACK после новой local revision/FULL | ACK не переписывает договор, первый FULL hash/time или квалификацию; CAS не last-write-wins |
| FX10-COM-023 | Старый actual FULL T1, revision T2, bank callback T3 | При T1<T2<T3 FULL по старой эффективной ревизии; новый snapshot не подменяет реальный первый расчёт |
| FX10-COM-024 | Тот же source fact доставлен старым и новым command/key; изменённый source ID content отдельно | Одна source identity; request/fact fingerprints различаются. Несовместимый факт — SOURCE_EVENT_CONFLICT, не overwrite |
| FX10-COM-025 | S4 зарегистрирована до late FULL; stale NOT_PAID/CANCELLED после FULL | Durable filing сохраняется; late delivery не добавляет окна/не стирает FULL, R17.1 проверяется точной qualified функцией |
| FX10-COM-026 | Повторный cash оборот +100000−100000+100000−25000 при продолжении | Остаток75000, старый refund не вычитается дважды, нет второй C/фиктивной полной отмены |
| FX10-COM-027 | Mixed synthetic scope: eligible10000, actual discount500, ineligible2000; refund только ineligible | Первоначальный FULL всего договора11500; G/D/C и S4 eligible scope не уменьшаются на неподходящий refund |
| FX10-COM-028 | Customer refund/акт оказания/access revoke без S4; затем полноценная S4 | Consumer процесс независим, факт refund сам C не меняет; только применимое мотивированное бинарное решение |
| FX10-COM-029 | Изменена новая договорная ревизия после истинного FULL | C/исходный S5 anchor не увеличены/не перенесены; доплаты сохранены в evidence |
| FX10-COM-030 | Rollback после первого BOUND, одновременно поздний успех денег | Новая выдача остановлена; старые obligations/read-back/истинный FULL обслуживаются без смены owner/повторного списания |
| FX10-COM-031 | Миграция/restore с изменённым старым SQL/hash либо более новой erasure tombstone | Immutable chain refusal; subject не оживает; независимый inventory не подменён восстановленной DB |
| FX10-COM-032 | Партнёрский payout report/UNKNOWN и спор об остатке | Мерчант сообщает факты по применимому контракту, не объявляет документ банковским исполнением; case closure/новый registry не погашают долг и не разрешают повтор |
| FX10-COM-033 | Первоначальный BOUND доказанно отказал; buyer явно выбрал обычную покупку | Нет BOUND по проверенному результату исходной команды; честная согласованная цена, native продажа/доступ допустимы, C и ретроатрибуции нет |
| FX10-COM-034 | Первоначальный BOUND UNKNOWN; UI предлагает обычную продажу через новую purchaseRef | Такой обход закрыт; прочитать прежнюю команду, не создавать второй scope/платёж. Отличать UNKNOWN от доказанного отказа COM-033 |
| FX10-COM-035 | SCHEDULED_SERVICE: отдельные fixtures actual FULL после frozen end и callback после end при actual FULL до него | Первый anchor=max(actual FULL,end)=actual FULL; второй=end. Callback receivedAt не anchor; 14 московских календарных дат от правильной границы |
| FX10-COM-036 | Частичная отмена: отдельные доказанные остатки ровно C и C+1коп при поддержанном provider execution | При остальных положительных guards первая даёт основание S4, вторая — нет; удовлетворённая S4 только C/0. Не обещает частичный refund вне выбранного bank scope |
| FX10-COM-037 | Доказанная отмена подходящих услуг, положительный cash refund, но есть согласованное продолжение той же покупки | Нет основания полной отмены; только guard продолжения отрицателен, прочие guards положительны; никаких второй C или двойного вычитания |
| FX10-COM-038 | Обычный customer refund после завершённого применимого PAYMENT окна и FINAL, без R17.1/закрытого исключительного основания | Customer refund/access policy исполняется отдельно; обычная S4 не меняет C. Не отменять судебные/settlement/исправительные основания |

### LMS / COURSES

| ID | Сценарий | Проверяемый результат |
|---|---|---|
| FX10-LMS-001 | Native paid immediate course с READY опубликованными материалами | Один COURSE entitlement и activation evidence, referral C не является guard доступа |
| FX10-LMS-002 | Refref недоступен после saved BOUND, native банк PAID | Обещанный доступ выдан, FULL/outbox сохранены; outage не требует второй оплаты |
| FX10-LMS-003 | Payment amount/currency/owner не совпал с frozen обязанностью | Нет grant/ложного FULL; scoped review/reconcile с исходными фактами |
| FX10-LMS-004 | Материал/видео не READY при payment admission | Нет фиктивной immediate readiness/неверного fiscal profile; уже принятые договоры не теряются |
| FX10-LMS-005 | После покупки опубликовано новое допустимое содержание курса | Динамический COURSE доступ сохраняется; initial material snapshot остаётся доказательством, не жёстким ceiling; нет новой C |
| FX10-LMS-006 | ALL_COURSES grant и последующее добавление курса | Доступ соответствует действующему scope; новое содержимое не становится второй покупкой/FULL |
| FX10-LMS-007 | ONLINE_COURSE qualification пытаются использовать для новой public COURSE_BUNDLE sale | Отдельный product/provider/fiscal gate не обходится |
| FX10-LMS-008 | Free enrollment, manual grant, FREE→PAID | Прежние основания доступа сохранены, без фиктивных банковских денег/нового BOUND/C |
| FX10-LMS-009 | Неизвестная оплата, return/resume в двух вкладках | Не повторять деньги/новыйintent на тот же scope; восстановление не автопереходит к банку без нужного действия |
| FX10-LMS-010 | Подтверждённый относимый refund, grant reconciliation и отдельная S4 | Исполняется buyer access/refund policy; S4 не используется как разрешение consumer refund или способ отозвать доступ |
| FX10-LMS-011 | Browser/Refref recipient пытается узнать customer email/lesson tokens | Стандартный result без buyer PII/private media; auth/consent/DRM scopes независимо проверяются |
| FX10-LMS-012 | PAYMENT либо специально qualified SCHEDULED_SERVICE LMS | Выбранный mode/anchor установлен до BOUND; progress/login/new content не сдвигают срок автоматически |

### LAB

| ID | Сценарий | Проверяемый результат |
|---|---|---|
| FX10-LAB-001 | Guest email/start → согласия → hold → BOUND → native full payment | Одна экономическая покупка/место/билет и один FULL/C; guest capability не является attribution |
| FX10-LAB-002 | Два клиента на последнее место | SQLite транзакция даёт один admissible hold, capacity не превышена |
| FX10-LAB-003 | Истёк краткий hold, но старая операция может settle | Место не перепродаётся по одному TTL; независимый owner cancellation/read-back закрывает денежный scope |
| FX10-LAB-004 | Late success после конца UI quote/hold | Деньги/договор не теряются; нет silent oversell или фиктивного NOT_PAID; buyer remedy отдельно |
| FX10-LAB-005 | Изменение цены/обычный offer close при уже выданном quote | Действительная гарантия цены/сроков соблюдена по qualified profile; новый quote закрыт, старый не продлён retry |
| FX10-LAB-006 | Emergency storefront stop/occurrence cancellation | Fresh payment admission блокирует новые операции; read-back/refunds/старые права работают |
| FX10-LAB-007 | Guest/start создал заказ, ответ потерян; создание новых заказов исчерпало source quota; многократный replay прежних capability/email | Подтверждённый replay возвращает исходный orderPublicId без нового заказа/платежа/BOUND и повторного расхода квоты создания. Quota exhaustion не блокирует recovery; ownership/erasure/security guards сохранены |
| FX10-LAB-008 | Чужой bearer/receipt либо запрос с LMS origin на LAB offer | Нет доступа к чужим документам/билету, origin/capability scope проверяется; identity не угадывается по email |
| FX10-LAB-009 | Повтор сканирования QR/use, затем попытка undo | Use не исполняется дважды и не превращается в редактируемый payment/referral status |
| FX10-LAB-010 | Замена участника/перенос в рамках продолжающейся покупки | Новая принятая ревизия/согласие, атомарные места, история билета; те же BOUND/C и исходный S5 |
| FX10-LAB-011 | Два переноса на последнее место другого occurrence | Не более одной новой allocation; отказ не уничтожает старое подтверждённое место/договор |
| FX10-LAB-012 | Прекращение и денежный refund, затем самостоятельная новая покупка | Прежняя история/claim сохранены; новая осознанная атрибуция до оплаты, без reuse consumed touch |
| FX10-LAB-013 | Частичный refund при provider full-only capability | До вызова корректный отказ в неподдержанном execution; документарная возможность S4 не расширяет bank scope |
| FX10-LAB-014 | Дата окончания occurrence, фактическое проведение и закрывающий чек | Три разные факта; чек/таймер не создаёт новый FULL/C и не доказывает посещение |
| FX10-LAB-015 | PAYMENT при ранней оплате vs SCHEDULED_SERVICE с frozen end | Разница окон ясна сторонам, enum LAB не выбирает mode автоматически; перенос не переписывает anchor |
| FX10-LAB-016 | Старый V1 token/URL после v10 cutover | Public V1 остаётся stopped/static410, архив не импортируется как v10 заказ; исторический recovery только в отдельно разрешённом scope |
| FX10-LAB-017 | Source quota исчерпана; предъявлены новая capability при том же email и отдельно чужая capability/изменённый email | Новый заказ по новой capability по-прежнему ограничен creation quota, изменённый email под известной capability отклонён; replay bypass не обходит security/erasure guards и не раскрывает чужой order |

### Устойчивая неоплаченная покупка / FX-C12

Это U1–U13 итоговой сверки, включённые под собственными ID. Периоды и варианты FX-C12 в fixtures выбираются синтетически для квалификации ветвей, не становятся defaults. Два разных документированных договорных исхода могут иметь одинаковый reported CANCELLED; решение следует фиксированной версии политики и фактам, а не усмотрению мерчанта после возвращения buyer.

| ID | Сценарий | Проверяемый результат |
|---|---|---|
| FX10-RES-001 | U1: цена истекла до BOUND | Preview не расходовал touch; после нового согласованного quote один BOUND до первой возможности оплаты |
| FX10-RES-002 | U2: BOUND есть, оплаты нет, quote истёк, buyer продолжает ту же покупку | LMS account ownership / LAB scoped capability либо квалифицированное recovery; не одно совпадение email. Те же purchaseRef/BOUND/партнёр, новый quote/revision, без повторного touch consumption |
| FX10-RES-003 | U3: BOUND записан, ACK потерян, handoff истёк | Ownership-checked recovery прежней команды; новый UI mount/handoff не создаёт второе право, оплата закрыта до read-back |
| FX10-RES-004 | U4: две вкладки одновременно resume/requote, включая потерянный ответ локального resume | Local purchase CAS/транзакция revision+outbox сериализуют приём, stale version перечитывается; idempotent recovery, не last-request-wins. Refref CAS не является разрешением локального договора |
| FX10-RES-005 | U5: quote истёк, старая session ещё исполнима либо исход банка UNKNOWN | Нет нового пересекающегося create; доказанное закрытие/read-back старой операции предшествует новой. Ключ старой операции не используется с новым телом |
| FX10-RES-006 | U6: истинный old FULL фактически наступил до новой ревизии, callback пришёл после | FULL относится к effective old hash/time; не просить оплатить заново, один grant/билет и одна C |
| FX10-RES-007 | U7: прежняя покупка окончательно прекращена по заранее выбранной политике; independent sale того же товара | Новый договор/purchaseRef и новое действие/BOUND для нового права. Совпадение account+product и consumed touch не переносят старого партнёра. Новые инструкции старой покупки закрыты, её read-back/history не отключены |
| FX10-RES-008 | U8: новая принятая ревизия продолжающейся покупки экономически неподходящая | Договор/BOUND сохранены, truthful FULL принимается, положительная C по неподходящей ревизии не обещана; это не S4-zero |
| FX10-RES-009 | U9: buyer вернулся после short quote expiry внутри выбранного периода продолжения | Та же purchaseRef/BOUND, новая согласованная цена и проверенная availability; нет автоматической потери партнёра из-за quote TTL. Период не вычисляется из campaign TTL |
| FX10-RES-010 | U10: touch уже истёк, действительный BOUND и продолжающаяся покупка сохранены | Допустимая поздняя оплата/FULL не требует нового touch; истечение касания относится к новому BOUND |
| FX10-RES-011 | U11: настоящий dueAt прошёл, профиль ещё допускает исполнение | Правдивый NOT_PAID сохраняет BOUND; поздний истинный FULL принят. Перенос dueAt обоснован реальным изменением, не refresh, и не стирает дефект отчётности |
| FX10-RES-012 | U12: до touch expiry ещё время, но LAB cutoff наступил/места нет | Нет продажи после cutoff, oversell или продления hold по одному BOUND. Сохраняются recovery/достоверные факты; случайный перевод без исполнения обязанности не объявляется FULL/C по сумме |
| FX10-RES-013 | U13: сообщён CANCELLED; buyer вернулся внутри периода, который заранее выбранный профиль разрешает для этой продолжающейся покупки | Explicit ownership+сохранённые объективные основания дают те же purchaseRef/BOUND/партнёра и одну C после действительного FULL; первоначальный CANCELLED остаётся в истории. Контрастный fixture RES-007: тот же reported CANCELLED, но доказанное окончательное прекращение — нельзя выбрать продолжение задним числом. Поздний истинный FULL до закрытия доставляется по старому BOUND при обоих вариантах |

Отрицательные guards проверять изолированно: valid attribution при позднем BOUND, положительная экономика при отсутствии attribution, действительный refund при продолжающейся покупке. Тест с несколькими одновременно ложными условиями не доказывает чувствительность каждого. Профильные E2E должны исполняться на реальных consumers, не только на oracle Refref.

## 6. Применимые CI и реальные verdicts

Текущий [.github/workflows/test.yml](../.github/workflows/test.yml) имеет два job `test` и `docker-build`: exact CI source checkout, immutable migrations, типы/тесты/сборки frontends/Commerce, isolation/restore/proxy checks и реальные container builds. Документационный PR сохраняет эти workflows. CI текущего проекта проверяет текущий код, а не реализацию будущих80 сценариев.

| Ось | Статус данного пакета | Что нужно после реализации |
|---|---|---|
| Source audit/docs integrity | Проверяется validator и review | Перепроверка target SHA при изменении main/upstream |
| Source/contract v10 реализации | NOT_RUN | Exact-head DB/concurrency/adapter guards, auth/scope, money/cash/effective-time tests |
| Served transport E2E | NOT_RUN | Работающие authenticated маршруты обеих систем, sourceReceipt/evidence/replay/outbox/restart |
| Provider/evidence E2E | NOT_RUN | Отдельно разрешённые банк/refund/fiscal scope и независимые read-backs |
| Public admission | Не выдаётся | Отдельные LMS, LAB, Mikluha E2E перед публичным Refref GO; фактические legal/profile authority |

Старая специфическая ошибка `PURCHASE_V9_TRANSPORT_NOT_QUALIFIED`, если она присутствует в выбранном исполняемом adapter, означает отказ маршрута v9, не разрешение отправить v10 через RC.2. Отсутствующий v10 endpoint блокирует transport qualification; новые маршруты в документах не доказывают deployment.

**CUSTODY_IMPACT: NO** для этого PR. Будущее provision/deploy/schema install с host resources отдельно перечисляет custody authorities и evidence согласно [AGENTS](../AGENTS.md). Ни publication, ни корректный restore, ни зелёный CI не дают автоматического разрешения на оплату, открытие storefront switch или повтор неизвестной операции.
