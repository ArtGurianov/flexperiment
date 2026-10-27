# LAB и LMS — архитектура Commerce под Refref v10

Редакция: 27.10.2026. **Независимый проект SOL для review**, не новый действующий ADR и не финансовая активация. Осмотренный Flexperiment: `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; Refref: `c932b656edbda1d47cfb57de08fd4a36536712f5`. Происхождение и открытые решения — в [README](README.md).

## 1. Одна система Commerce, два профиля

Flexperiment сохраняет собственные каталог, цены, договоры, покупателей, доступ LMS, билеты/места LAB и исполнение услуг. В новом профиле он также принимает покупательские деньги и исполняет возвраты через свой квалифицированный adapter. Refref хранит атрибуцию, BOUND, комиссию и применимые дела/реестры. Его v10 API — целевая спецификация, а не доказанный работающий endpoint.

| Область | LMS / COURSES | LAB | Общая граница |
|---|---|---|---|
| Товар и исполнение | ONLINE_COURSE / COURSE_BUNDLE; опубликованные материалы, динамический доступ, entitlement, playback | LAB occurrence, билет/допуск, вместимость, проведение мастер-класса | Product kind и storefront не становятся новыми типами комиссии |
| Личность | Better Auth/проверенная customer-сессия; восстановление доступа | Guest capability/email/recovery и операционный admission | Ни account ID, ни bearer-билет не являются реферальным touch |
| Деньги | Покупательский долг/поступление отдельно от grant/access | Поступление отдельно от hold/выдачи/использования билета | Native payment/refund adapter Flexperiment; Refref не создаёт банковские операции |
| Реферальный результат | BOUND до первой возможности оплатить; FULL по действительной покупке | То же; anchor услуги задан явно при scheduled mode | Одна экономическая покупка, один BOUND и одна исходная C |
| Фискализация | Сохранить квалифицированную модель готовых материалов и её доказательства | Предварительная оплата/оказание/зачёт по выбранному профилю | Нельзя выбрать фискальный способ по FINAL или общей кнопке PAID |

Предоплаты Mikluha не становятся обязательной новой функцией LAB/LMS. Текущий источник продаёт полную цену одной платёжной обязанностью. Если Flexperiment захочет собственные депозиты/кредит/поэтапную оплату, коммерческие условия и provider scope квалифицируются отдельно; Refref уже допускает merchant-managed взносы без их ledger в Core. Этот проект не добавляет рассрочку как условие запуска.

## 2. Факты текущего source baseline

Сверка выполнена по актуальному `origin/main`, не по локальной ветке другого проекта и не по незамерженным checkout-исправлениям. Источники закреплены в [source-baseline.json](source-baseline.json); здесь не обследовались установленная БД, хост, клиентские данные или кабинеты банка.

| Наблюдение | Проверяемый источник | Что следует для v10 |
|---|---|---|
| Commerce V2 — SQLite/WAL, BEGIN IMMEDIATE, lineage `flexperiment-v2` | [db.ts](../commerce-v2/src/db.ts), [storage contract](../docs/v2-merchant-schema.md) | Нет необходимости переносить Commerce в PostgreSQL Refref; concurrency и outbox остаются локальными |
| 35 неизменяемых SQL 0001–0035, точный lock и prefix journal | [migration integrity](../commerce-v2/src/migration-integrity.ts), [migration.lock](../commerce-v2/migrations/migration.lock) | Только новые forward SQL после фактического suffix; старые bytes/подписи не переписывать |
| Окружения `disabled`, `mock`, `refref`; native merchant rail пока отсутствует | [payment-mode.ts](../commerce-v2/src/payment-mode.ts), [rail](../commerce-v2/src/refref-payment-rail.ts) | Старый `refref` означает RC.2 acquiring, а не будущий reporting-only v10 |
| resolve → attempt → payment-session, read-back и refund выполняются через Refref | [checkout.ts](../commerce-v2/src/checkout.ts), [protocol](../docs/refref-checkout-protocol.md) | Разделить provider execution Flexperiment и referral reporting; сохранить обслуживание старых V2 попыток |
| Order и принятая legal/fiscal цена заморожены; quote/intent persist до внешних операций | [checkout](../commerce-v2/src/checkout.ts), [0030](../commerce-v2/migrations/0030_checkout_intents.sql), [0011](../commerce-v2/migrations/0011_canonical_order_snapshots.sql) | Не переделывать исторический snapshot в изменяемый v10 DTO |
| Arrival хранится в SQLite; preview реально вызывает deliveryForBuy с бюджетом 1500 мс | [browser-context](../commerce-v2/src/browser-context.ts), [app.ts](../commerce-v2/src/app.ts), [0034](../commerce-v2/migrations/0034_browser_contexts.sql) | Cookie/legacy receipt не являются v10 TTL; deliveryDegraded не разрешает обход неизвестного BOUND |
| PAID projection выдаёт COURSE/ALL_COURSES либо LAB acceptance; Refref ACK — отдельный шаг | [checkout](../commerce-v2/src/checkout.ts), [entitlements](../commerce-v2/src/entitlements.ts), [lab-tickets](../commerce-v2/src/lab-tickets.ts) | Доступ и билет не должны ждать C/FINAL либо доставки referral-outbox |
| Host-owned storefront switch COURSES/LAB и ограничения offer существуют отдельно | [storefront-switch.ts](../commerce-v2/src/storefront-switch.ts), [0035](../commerce-v2/migrations/0035_storefront_switch.sql) | Native rail обязан сохранять свежий payment admission; смена получателя денег не снимает операторский stop |
| LAB V1 физически остановлен; V2 frontend — `apps/lab-v2` | [AGENTS](../AGENTS.md), [V2 frontends](../deploy/v2/frontends/README.md) | Нельзя возобновлять V1/public token routes или импортировать архив как новые V2 покупки |

Документы v9 описывают исторический target: after-discount commission, старые возвратные условия и +30-дневные переносы не переносятся в новые права v10. Исторические приобретённые права сохраняют свою политику. Зелёный CI, закрытый canary или существующая схема не доказывают публичный допуск нового профиля.

## 3. Рассмотренные варианты

| Вариант | Выбор | Причина |
|---|---|---|
| Оставить RefrefPaymentRail исполнителем, переименовав его в v10 | Отклонён | Нарушает merchant-native границу и смешивает provider outcome с доставкой сообщения Refref |
| Отдельные Commerce для LMS и LAB | Не требуется | Каталог/identity/операции/доказательства уже общие; различия выражаются профилями доступа/мест/исполнения |
| Сохранить Commerce V2 и добавить отдельные native execution + referral adapter | Предлагается | Минимально заменяет ответственность оплаты, сохраняя имеющиеся grants, guest tickets, stop, recovery и документы |
| Возобновить V1 ради временной совместимости | Запрещено текущими правилами | V1 retired; восстановление исторических случаев имеет отдельный архивный путь и явную authority |

## 4. Минимальные логические записи

| Запись | Содержание | Обязательная гарантия |
|---|---|---|
| Экономическая покупка | `purchaseRef`, storefront, product profile, payment owner/flow, legacy order link | Устойчивый ID не включает email/user ID; профиль не выбирается заново по retry |
| Принятая ревизия | Договорные состав/цена/график, lineRef, документы/hash, согласие и effective times | Исправление добавляет версию; прежний принятый snapshot не переписывается |
| Native operation / cash fact | Provider connection/operation ID, ключ, purpose, сумма/валюта, стадия/исход, source evidence/time | UNKNOWN не FAILED; сумма не считается дважды между callback/read-back/restart |
| Связь денег | Allocation на покупку/строки/возврат; отдельный unknown scope | Не распределять свыше реальной суммы; неподходящие строки не становятся eligible из merchant-флага |
| Fulfilment | LMS grant/material readiness; LAB hold/acceptance/ticket/use; fiscal obligations | Денежное исполнение, доступ, услуга и фискальный итог — разные факты |
| Refref delivery | Touch/BOUND result, source events/outbox, immutable receipt, processing result | BOUND до первой возможности оплаты; FULL snapshot/hash/time не зависит от позднего ACK |

Это логическая карта для будущего DDL, не по одной новой таблице на каждую строку. Универсальный покупательский баланс, новый внутренний партнёрский кабинет, escrow, универсальный движок билетов/рассрочек и второй финансовый ledger Refref в Flexperiment не нужны.

SQLite write transaction не удерживается во время HTTP. Локальный исход денег/исполнения и исходящая запись фиксируются атомарно; lease/dispatch fencing защищают реальную операцию. Между Commerce, провайдером и Refref нет распределённой ACID-транзакции: recovery опирается на прежние IDs/источники, а не на новый idempotency key.

## 5. Простой новый поток

```mermaid
sequenceDiagram
  participant U as Покупатель LMS/LAB
  participant C as Commerce V2
  participant R as Refref v10
  participant P as Native provider
  U->>C: Принятые условия + допустимое действие
  C->>R: BOUND до invoice/payment link/session
  R-->>C: Durable результат / read-back команды
  C->>P: Одна допустимая покупательская операция
  P-->>C: Подтверждённый исход
  C->>C: Денежный факт + grant/билет по профилю + outbox
  C->>R: Истинный FULL с собственной ревизией/snapshot
  R-->>C: sourceReceipt; отдельная квалификация C
```

Диаграмма относится к реферальному пути. Бесплатная выдача доступа и обычная продажа без BOUND не требуют нового реферального права/потока organic. Нельзя маскировать UNKNOWN первоначальной команды BOUND обычной продажей или обещать ретроатрибуцию. После уже сохранённого BOUND outage Refref не блокирует безопасное исполнение и локальные договорные изменения.

Истинный FULL — первая действительная полнота исполнения по эффективной договорной ревизии, а не редирект, принятый банковский запрос, созданный чек, grant или посещение занятия. Он сообщает факты MERCHANT_ATTESTED; независимым банковским доказательством сообщение не становится. Реферальный процесс не должен останавливать выдачу уже оплаченного доступа/билета из-за недоставленного FULL.

## 6. Ревизии и две независимые истины

Локальный договор меняется по согласию/полномочиям, местам и реальной денежной истории. Квалификация Refref и её доставка — отдельный процесс по [контракту](04-refref-integration.md). Отказ/UNKNOWN ревизии не откатывает договор, не уничтожает депозит/оплату/BOUND и не создаёт S4-zero. По принятому R6.2 неподходящей эффективной FULL-ревизии нельзя обещать положительную C; техническая ошибка не равна экономической непригодности.

При первом действительном FULL C фиксируется один раз. Последующее изменение состава курса, добавление участника LAB, перенос occurrence или доплата не увеличивают эту C и не двигают исходный S5 anchor. Согласованное продолжение сохраняет purchaseRef/BOUND даже при refund/recharge; самостоятельная новая покупка требует нового действия/BOUND. Нельзя объявить перезаписанный технический order новой продажей ради другой комиссии.

Выбор PAYMENT/SCHEDULED_SERVICE и точного scheduled end — договорное условие кампании/профиля, а не результат enum ONLINE_COURSE/LAB или фискального способа. PAYMENT при ранней оплате может завершить обычное окно до занятия. Для немедленного LMS нет бесконечного якоря от последнего логина/обновления контента. Подробности отдельных профилей — [LMS](02-lms-profile.md) и [LAB](03-lab-profile.md).

## 7. Граница проекта и реализации

Этот пакет не меняет действующие buyer terms, scoped owner decisions о готовых материалах/динамическом доступе, роли, sale-mode, host state или принятую реферальную политику. Неподтверждённые provider/receipt возможности обозначаются как условия допуска. Никакого обязательного внешнего counsel approval вместо принятой OWNER-процедуры не вводится; реальные правовые/налоговые полномочия всё равно проверяются.

Переход выполняется последовательно на изолированном локальном стенде с синтетическими адаптерами; затем отдельно source/contract, served transport, provider/evidence и отраслевой допуск. Неполный контракт или неизвестный исход не маскируются положительным CI. [План миграции и сценарии](06-migration-and-e2e.md) сохраняет старые V2 финансовые операции и retired boundary V1 без восстановления публичного legacy runtime.
