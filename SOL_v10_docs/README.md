# Flexperiment LAB и LMS × Refref v10 — независимый пакет SOL

Дата: **27 октября 2026 года**. Статус: **документационный проект для сравнения и OWNER review**. Материалы OPUS не просматривались. Разработка ведётся на собственной ветке от проверенного main; пакет не объявляется единой канонической архитектурой до сравнения/утверждения. Код, SQL, рабочие договоры, host state и деньги не меняются.

## Порядок чтения

1. [Commerce Architecture](01-commerce-architecture.md) — фактический baseline, владельцы данных и предлагаемые изменения.
2. [LMS / COURSES](02-lms-profile.md) — курс, bundle, доступ, identity, ready materials и возврат.
3. [LAB](03-lab-profile.md) — guest checkout, occurrence, места, билет/перенос и исполнение.
4. [Refref integration](04-refref-integration.md) — общий контракт BOUND/FULL/revisions/receipts и миграция Arrival.
5. [Fiscal & Legal Impact](05-fiscal-legal-impact.md) — независимые договорные/денежные/фискальные факты и профильные условия допуска.
6. [Migration & E2E](06-migration-and-e2e.md) — forward-only переход и будущая программа приёмки.

## Источники и независимость

| Источник | Зафиксированная редакция | Предел доказательности |
|---|---|---|
| Flexperiment `origin/main` | [`c8bad757c9daa04385f9cf5e95bf6e07b185080a`](https://github.com/ArtGurianov/flexperiment/tree/c8bad757c9daa04385f9cf5e95bf6e07b185080a) | Source audit; Commerce V2 имеет35 SQL-миграций 0001–0035. Не установленная БД и не read-back сервера |
| Refref [PR #130](https://github.com/ArtGurianov/refref/pull/130) | [`c932b656edbda1d47cfb57de08fd4a36536712f5`](https://github.com/ArtGurianov/refref/tree/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10) | O1–O7, ADR-141 и технический FULL intake по неизвестной/неподходящей ревизии; PR открыт при сверке, endpoint не предполагается работающим |
| Текущие договорные/продуктовые основания Flexperiment | Существующие source decisions и архивы по ссылкам в профилях/05 | Различать принятые решения, предложенные bytes, запись публикации и действительность конкретного акцепта/полномочий |
| Прямое задание OWNER | Независимый документационный PR для LAB/LMS по аналогии с Mikluha | Не утверждает новые коммерческие числа, новое provider authority, публичный запуск или обязательную рассрочку |

Пакет содержит ссылки и хеши первичных Git blobs в [source-baseline.json](source-baseline.json); копий всех исходных документов нет. Ссылки Refref приватные: внешнему читателю потребуется доступ. После squash-merge upstream pin и хеши обновляются вместе после проверки содержимого, не заменой одного SHA. Снимок старой локальной ветки не используется как baseline миграции.

Мы не читали каталог/ветку/PR пакета OPUS и не использовали его выводы. После разрешённого OWNER сравнения возможна одна общая редакция; нынешний SOL-проект не должен конкурировать с ней как параллельный нормативный источник. Закрытые решения Refref повторно не выносятся на голосование.

## Сохранённые границы

- Commerce V2 владеет покупательской продажей, собственными native payment/refund фактами и исполнением. Refref не выдаёт LMS-доступ, не резервирует место и не принимает деньги покупателя.
- BOUND сохраняется до **первой возможности оплаты**, включая invoice/link/session. Его неизвестный результат не обходится «degraded» режимом.
- После существующего BOUND локальные договорные изменения и безопасная доплата не ждут ACK ревизии. Истинный FULL устойчиво принимается по собственному снимку; приём, пригодность и C — разные результаты.
- C одна, фиксируется по первой действительной FULL-ревизии; неприменение скидки само не отменяет право. `D_rule` и `D_applied` различаются. Отказ по пригодности — не S4-zero и не удаление BOUND.
- Grants/динамический LMS-доступ, LAB-билеты/допуск, фактическое исполнение, фискализация и FINAL независимы. Реферальный outage не откладывает законное исполнение оплаченной покупки.
- Покупательский refund не ждёт S4. В Refref нет обязательного organic/refund stream; при претензии сохраняется полный относимый денежный снимок.
- UNKNOWN конкретной денежной операции запрещает слепой пересекающийся повтор. Возврат, новая оплата и backup replay не создают второй C или второй платёж автоматически.
- V1 retired: не запускать public legacy runtime, не создавать фиктивные V2/v10 заказы из архивов. Прежние V2 RC.2 tails обслуживаются в их сохранённом scope/authority.
- Обязательные предоплаты Mikluha **не** превращаются в обязательный новый продукт LMS/LAB. Исходная полная оплата поддерживается; иной график — отдельный выбранный профиль.

## Решения/квалификация Flexperiment до нового финансового профиля

Это оставленные условия реализации, а не предложение отменить уже принятые гарантии. Числа в тестах — синтетические, не новые коммерческие defaults.

| ID | Что требуется | Что уже закрыто / чего нельзя предполагать |
|---|---|---|
| FX-C01 | Фактические Business/seller/qualified-agent роли, соответствие storefront COURSES/LAB и accepted campaign terms | Один локальный customer не разрешает cross-origin/person matching или переназначение партнёра |
| FX-C02 | Native acquiring/refund provider/connection/credentials и квалифицированная provenance/read-back; fiscal responsibility | Старые `PAYMENT_MODE=refref`, canary bank/ККТ доказательства и V1 договор не дают автоматически новый native scope |
| FX-C03 | Согласованный `fullPaymentDueAt` каждой покупки и допустимая payment opportunity/quote policy | Обязательность поля уже принята Refref;15-минутный quote или lifetime cookie не заменяют выбранный договорный срок |
| FX-C04 | LMS finality mode и точный исходный scheduled anchor, если такой профиль действительно применим | Нельзя использовать last login/progress/будущее обновление курса как бесконечный anchor; ready-material fiscal choice сам mode не задаёт |
| FX-C05 | LAB finality mode, точное окончание подходящего occurrence/программы с provenance/zone, versioned at BOUND | При PAYMENT ранняя оплата может закрыть обычное окно до события. Перенос после BOUND не переносит anchor автоматически |
| FX-C06 | Scope изменяемых покупок: согласие, effective times, LINE identity, переносы LAB/ценовые корректировки; отдельно желаемые смешанная корзина/несколько участников/этапы оплаты | Достоверная история нужна уже сейчас, но групповой checkout, произвольная корзина или сертификаты не становятся обязательными функциями |
| FX-C07 | Перепривязка storefront action/holder flow к v10: 72h/R14.1, TTL кампании, Apply/ORDER_SUBMIT, BOUND recovery | Старый Arrival receipt/cookie/degraded не создаёт право v10. Scope двух storefront сохраняется |
| FX-C08 | Snapshot/source-event intake и receipt recovery; поздний контекст, CAS vs append-only, профильная late-report функция R17.1 и календарь | Intake неизвестной/неподходящей ревизии уже определён c932b65; gate доказывает реализацию, не выбирает финансовую семантику заново |
| FX-C09 | Актуальные buyer documents/акцепт/доставка, конкретный native fiscal mapping, ПД/retention/erasure и реклама по фактическому профилю | OWNER-процедура вместо обязательного внешнего counsel и ready-material FULL_PAYMENT/динамический доступ сохраняются. Новые provider возможности всё равно требуют фактов/доказательств |
| FX-C10 | Согласованные inventory/cutover/restore по реальным V2 attempts/grants/tickets/refunds; доступность безопасного recovery прежнего owner | Документационный source snapshot не доказывает пустую БД, законченные canary операции или право удалить их |
| FX-C11 | Отдельная qualification ONLINE_COURSE, COURSE_BUNDLE и LAB и граница публичного допуска | Acceptance одного курса не открывает bundle/LAB. Общая архитектура Refref не блокирует независимый бесплатный Stage A |

## Проверка пакета

`python3 SOL_v10_docs/validate-package.py` проверяет состав/хеши проекта, локальные ссылки/якоря, закреплённые Flexperiment Git blobs и immutable35 SQL, уникальность планируемых E2E и документационную границу. Для сверки внешних Refref blobs доступен `--refref-repo /absolute/path/to/refref`; без него проверка честно помечает внешние bytes как не проверенные, не требует соседнего checkout или архивов агентов.

Этот validator не запускает target implementation, браузер, банк или E2E. Source/contract новой реализации, работающий authenticated transport и реальные provider/evidence проверки остаются **NOT_RUN**. Применимые existing CI выполняются для конкретного HEAD PR и не доказывают v10. Старые SQL/код/договоры не редактируются этим пакетом.

**CUSTODY_IMPACT: NO.** Созданы только независимые проектные материалы SOL. Никаких credentials, host env/networks, backups, provider operations, deployments, миграций установленной БД или публикации оферт. Новые задачи Linear не создаются; merge и публичный GO не выполняются.
