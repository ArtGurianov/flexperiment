# FLEX-75 · Частичная приёмка закрытого Stage A

**24 ноября 2026. Локальный A-1 — PASS в проверенном объёме. Локальный A-7 — FAIL по сохранению отписки после восстановления.** Удаление аккаунта переживает восстановление. One-click отписка действует в исходной базе, но после восстановления более раннего снимка допускает отправку. Решение об открытии остаётся в FLEX-16.

## Точная основа

- База и исходный HEAD изолированного прогона `72b02da924d342e9e2c24b2e5ce73146bdc06d77`. Встроенный `/identity` локального Commerce совпал до сценарных запросов. SQLite применяет 37 миграций. `commerce-v2:check-migrations` сверил 37 файлов по lock и 22 исторических дерева. При восстановлении совпал журнал версий и SQL SHA-256, прошли штатная проверка отпечатка схемы, `integrity_check` и `foreign_key_check`.
- Четыре точных документа из закрытой редакции `2026-11-24.stage-a.candidate.3` в draft #305 на `ea251ec62408822f275c2570ee8dc58c4a4034eb`. SHA-256 файла `SHA256SUMS` — `bd46ab170bf521f05821cb6d51e81d189d3608de5e0e5fc3a4bff4c5642f66fb`. Хеши всех четырёх blobs сверены с этим комплектом. [Draft #305](https://github.com/ArtGurianov/flexperiment/pull/305)
- Точный `manifestSha256` локально активированной записи и двух подтверждённых действий — `c0b19f841a1ae77c1cc0610812a3549252c6b84613fbbc3cab3b904cf53678a3`. Локальный манифест использует HTTPS URL под `documents.example.test`, отдельные от canary. В хеш Commerce входят эти URL и хеши файлов. `effectiveAt` фикстуры — `2026-11-24T04:42:35.000Z`. [FLEX-75](https://app.plane.so/art-workspace/browse/FLEX-75/)
- VPS-28 фиксирует custody установленного Stage 2 по предыдущему независимому протоколу. Этот прогон использовал loopback Commerce, прокси-функцию Platform, память для писем и локальный S3-транспорт SDK. [VPS-28](https://app.plane.so/art-workspace/browse/VPS-28/)

## Результаты

| Сценарий | Наблюдение |
| --- | --- |
| Magic-link | Локальный транспорт принял 3 письма для синтетических адресов. Две действующие ссылки выпустили сессии и вернули HTTP 302 к исходному пути урока с query. `/v1/me` в обоих случаях вернул 200 и `Cache-Control: no-store`. Атрибуты сессии — Secure, HttpOnly, SameSite=Lax, host-only. |
| Одноразовость и срок | Повтор одного успешно использованного URL и первая попытка открыть отдельную ссылку через 601 секунду по часам фикстуры вернули `INVALID_TOKEN` с нулём новых сессий. |
| Факт согласия | Две попытки с неправильным хешем дали HTTP 409 `LEGAL_RELEASE_STALE` и 0 записей. По верному хешу — 2 действия, 6 положительных событий. Для каждого события сверены версия релиза, `manifest_sha256` и SHA-256 соответствующего документа. |
| Штатный снимок | Создан до обеих операций из read-only источника `openBackupSource` через `backupFoundation`, те же реализации, что использует `commerce-v2/src/backup-cli.ts`. Режим WAL и штатное шифрование age. Архив этого прогона — 946600 байт, SHA-256 `1b858644262d5df40b1917590e51376d07fb76bf488c7611f66facd66949fb9a`. До восстановления сверены хеш и размер. |
| Удаление аккаунта B | После снимка штатный `runErasureOwnerOperation(admit)` принял подлинную сессию Better Auth, подтвердил независимую запись и удалил аккаунт. После `reconcileIsolatedRestore` отсутствуют аккаунт, Better Auth user, согласия, получатель кампании и auth-outbox этого субъекта. Сессий в копии 0. |
| Отписка аккаунта C | После снимка штатный `POST /v1/email/unsubscribe` вернул 200 и создал активную строку `ONE_CLICK` в исходной SQLite. Исходная кампания — 0 вызовов транспорта. Независимый журнал — 1 `ERASURE`, 0 `MARKETING_SUPPRESSION`. После сверки копии C сохранился, строка подавления отсутствовала, старая кампания вызвала локальный транспорт **1 раз**. |
| Контроль восстановления | Отказ при недоступной независимой authority. Из того же снимка, после публикации тестового подписанного `MARKETING_SUPPRESSION` через существующий `publish-pending`, reconciler прочитал и проверил обе записи. B отсутствует, C сохранён, получателей `SKIPPED_SUPPRESSED` — 1, локальных отправок — 0. Состояние результата `RECONCILED_CLOSED`, `runtimeAdmission=PENDING`. |

`unsubscribeCustomer` сохраняет отписку в merchant SQLite. Штатный owner-admit публикует `ERASURE`. При откате к снимку штатный reconciler читает текущую подписанную цепочку, в которой отсутствует отписка. Тестовая вставка события проверяет уже существующего потребителя `MARKETING_SUPPRESSION`. Для закрытия G-09 нужен путь от подтверждённой пользовательской отписки до независимого источника восстановления и отдельный повтор этого сценария с **0** вызовов транспорта. [FLEX-75](https://app.plane.so/art-workspace/browse/FLEX-75/) · [FLEX-38](https://app.plane.so/art-workspace/browse/FLEX-38/)

## Воспроизведение

Запускать из отдельного чистого checkout точного базового SHA. Для команд требуются Bash или Zsh, Node.js 22, pnpm 10.29.3, `age` и `age-keygen`. Файл [stage-a-recovery.ts.txt](fixtures/stage-a-recovery.ts.txt) содержит исходник синтетической фикстуры. Её SHA-256 — `4c08ea7aa5d4627386fd57dbfc93c4ecfe7d66363eaa0a67e44de7a3256572c4`.

```bash
set -eu
test "$(git rev-parse HEAD)" = 72b02da924d342e9e2c24b2e5ce73146bdc06d77
git cat-file -e ea251ec62408822f275c2570ee8dc58c4a4034eb^{commit}
pnpm install --frozen-lockfile
pnpm commerce-v2:check-migrations

fixture=commerce-v2/test/stage-a-recovery.local.test.ts
test ! -e "$fixture"
cp "${FLEX_EVIDENCE_DIR:?}/fixtures/stage-a-recovery.ts.txt" "$fixture"
trap 'unlink "$fixture"' EXIT
pnpm exec vitest run --no-silent --project node "$fixture"
pnpm exec vitest run --project node \
  commerce-v2/test/{stage-a-preparation,authenticated-consents,runtime-backup,erasure-owner,erasure-restore,restore-reconciliation,erasure-library-read,campaigns}.test.ts
```

Фикстура завершает тест успешно, когда воспроизводит зафиксированный дефект и контрольный сценарий. Критерий приёмки считывается из строки `RESULT=FAIL`. Хеш повторного age-архива меняется из-за одноразовых ключей, шифрования и записей конкретного прогона. Фикстура проверяет размер и SHA-256 каждого созданного снимка перед восстановлением и удаляет изолированные копии при завершении. Дополнительные Commerce-тесты — **187/187 PASS**.

## Дополнение после ревью · 25 ноября 2026

Повтор выполнен в отдельном чистом worktree на исходном SHA `72b02da924d342e9e2c24b2e5ce73146bdc06d77` и том же точном манифесте. Штатный age-снимок создан до удаления и всех трёх путей отзыва. Его SHA-256 — `a048101d364cc42da78a816a19e635dddd1dd24f46d36c285d2b46e7bb4d3581`, размер 946600 байт.

| Маршрут после снимка | Исходная база | Независимый факт отзыва | Вызовы локального транспорта после восстановления |
| --- | --- | --- | --- |
| `POST /v1/me/consents/marketing` | HTTP 200, подтверждённый выбор `false` | 0 событий | **1** |
| `POST /v1/me/consents` | HTTP 200, подтверждённый выбор `false` | 0 событий | **1** |
| `POST /v1/email/unsubscribe` | HTTP 200, активное подавление | 0 событий | **1** |
| Положительный контроль `MARKETING_SUPPRESSION` | Подписанное событие отдельно опубликовано штатным механизмом | 1 событие | **0** |

Для повтора выполнить команды выше с файлом [stage-a-withdrawal.ts.txt](fixtures/stage-a-withdrawal.ts.txt), SHA-256 `d4314fe80025c264f9233ddedd71e3ab9c2ef562634d6be49c2c71c1f7f436c1`. Скопировать его в `commerce-v2/test/stage-a-withdrawal.local.test.ts` и запустить тем же Vitest. Отдельно проверить три строки `RESULT=FAIL` и контроль с `RESTORED_SENDS=0`. Зелёный статус диагностического теста подтверждает воспроизведение дефекта. Reconciler сохранил `RECONCILED_CLOSED` и `runtimeAdmission=PENDING`.

Владелец определил правило повторного согласия. Новое явное согласие заменяет прежний отзыв из кабинета. Это действие не снимает подавление после one-click отписки. На проверенной реализации 0037 восстановление теряет отзыв по всем трём маршрутам, включая one-click. Предложенные критерии отдельного исправления включают восстановление подтверждённых отзывов каждого типа, ноль отправок при неопределённости, идемпотентную обработку повторов и потерянного ACK и сохранение границы custody. [FLEX-38](https://app.plane.so/art-workspace/browse/FLEX-38/) · [FLEX-75](https://app.plane.so/art-workspace/browse/FLEX-75/)

## Проверка с ожидаемым нулём отправок

Патч [stage-a-withdrawal-require-zero.patch](fixtures/stage-a-withdrawal-require-zero.patch) превращает диагностическую фикстуру в проверку, которая требует ноль восстановленных отправок по каждому из трёх маршрутов. Штатные операции выполняются до восстановления. Ручная публикация события из положительного контроля в этой проверке исключена.

```bash
set -eu
test "$(git rev-parse HEAD)" = 72b02da924d342e9e2c24b2e5ce73146bdc06d77
evidence="${FLEX_EVIDENCE_DIR:?}"
fixture=commerce-v2/test/stage-a-withdrawal.local.test.ts
test ! -e "$fixture"
cp "$evidence/fixtures/stage-a-withdrawal.ts.txt" "$fixture"
trap 'unlink "$fixture"' EXIT
test "$(shasum -a 256 "$fixture" | cut -d' ' -f1)" = d4314fe80025c264f9233ddedd71e3ab9c2ef562634d6be49c2c71c1f7f436c1
git apply --unidiff-zero --check "$evidence/fixtures/stage-a-withdrawal-require-zero.patch"
git apply --unidiff-zero "$evidence/fixtures/stage-a-withdrawal-require-zero.patch"
pnpm exec vitest run --no-silent --project node "$fixture"
```

На 0037 в трёх строках `WITHDRAWAL_ROUTE` получено `RESTORED_SENDS=1`, Vitest завершился с кодом 1 и `RESTORED_MARKETING_SENDS_DETECTED`. Для будущего исправления установите `STAGE_A_SOURCE_SHA` равным фактическому HEAD кандидата и квалифицируйте его независимый транспорт внутри фикстуры. Ожидаемый результат — успешный выход Vitest и `RESTORED_SENDS=0` по всем трём маршрутам.

## Граница допуска

Локально проверены почтовый протокол, факт согласия и восстановление на синтетических данных. Эксплуатационная часть A-1 остаётся за отдельным допуском закрытого canary и реальной почты. A-2, реальный Flexing Basics и Kinescope требуют своих проверок. Полный A-7 требует штатного объекта Cloud.ru, свежести и алерта, независимо подтверждённого журнала и исправления отписки. Cloud.ru lifecycle и публичная юридическая активация требуют отдельных допусков. [FLEX-16](https://app.plane.so/art-workspace/browse/FLEX-16/) · [FLEX-128](https://app.plane.so/art-workspace/browse/FLEX-128/) · [VPS-28](https://app.plane.so/art-workspace/browse/VPS-28/)
