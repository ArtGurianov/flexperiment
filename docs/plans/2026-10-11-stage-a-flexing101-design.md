# Stage A: один бесплатный курс — подготовка, не запуск

ART-232 / ART-169 / ART-179. Решение владельца от 11.10.2026.

## Keep from original

Существующие Payload collections, immutable refs, manifest/video pipeline и Commerce FREE access policy. F7, V1, Refref и production не меняются. Регистрация, публикация, выплаты и четыре HTTPS guards остаются закрытыми. Юридическое и редакционное утверждение не выводятся из CI.

## Adopt from alternative

- **Material improvement:** один Flexing 101 вместо ожидания всего каталога. Уменьшает объём данных запуска без изменения архитектуры.
- **Material improvement:** четыре отдельных юридических черновика вместо блокировки инженерной подготовки до получения готовых текстов. Финальное утверждение остаётся у владельца/юриста.
- **Context-dependent tradeoff:** draft-only Local API preparation в отдельной SQLite, а не запись неутверждённого контента в live closed canary. Проверяет настоящие collections/hooks/transactions, не обходит запреты live runtime.

## Reject

Не копировать V1 согласия для нового аккаунтного контура; не генерировать videoRef, цены, реквизиты или legal release. Не добавлять отдельный publishing service и не менять закрытые canary hooks. Альтернатива ручного создания всех записей через CMS остаётся допустимой, но хуже воспроизводится в тесте; импорт published seed недопустим до утверждения.

## Conflicts and risk delta

Разрешение автономной подготовки не равно разрешению на утверждение содержания. Реальные UUID появляются только при создании настоящих draft records; тестовые UUID не становятся каноническими launch refs. Плановые минуты не превращаются в длительность обработанного видео. Остаются неизвестны адрес оператора, договоры обработчиков, сроки хранения и возрастная политика: это вопросы одного юридического утверждения, не новые инфраструктурные GO.

Фактическая проверка `AccountClient` обнаружила один checkbox, объединявший ПД, правила и ознакомление с политикой. Исправляется минимально: два отдельных required действия и отдельный optional marketing, всё unchecked. Новый явный `accountTermsAccepted=true` проверяется на HTTP boundary до CAPTCHA и повторно в auth runtime до DB/email. Старые клиенты без этого действия отказывают; исторические согласия не переписываются. Перед будущим E2E нужен matching API/frontend release, без публичного окна смешанной регистрации. Live закрытая регистрация не изменяется этим PR.

## Revised merged plan

1. Четыре Markdown DRAFT документа и перечень подтверждённых/неподтверждённых фактов.
2. Статическая editorial proposal и атомарное создание draft course → section → четыре lessons через существующие access/hooks, без hero/video/manifest/jobs.
3. Настоящая изолированная Payload SQLite: отношения, UUID, draft isolation, rollback, guest refusal и отсутствие внешнего I/O.
4. Existing auth/FREE/playback tests + сценарий будущего browser E2E. Тестовые fixtures не считаются legal/video admission.
5. Focused PR, exact-head CI и обновление существующих ART issues. Без бесполезного redeploy неизменённых live runtime.
6. После утверждения текстов/курса и реальных видео — обычный существующий upload → manifest → FREE product admission → закрытый canary E2E. Public registration и F9 отдельно не разрешены.

## Review follow-up: attribution до подтверждения адреса

Review #195 исключил legal approval. Подтверждённый дефект: новая неподтверждённая
заявка создаёт marketing row для уже verified customer; прежняя audience проверка
считала текущее владение email достаточным доказательством того старого checkbox.

Выбран минимальный fail-closed correction: additive migration23 явно помечает
historical evidence LEGACY_UNQUALIFIED, новые запросы UNVERIFIED_INTENT; отдельный
AUTHENTICATED_ACTION требует verified binding и source/time. Campaign queue и
dispatch игнорируют intents полностью (ни opt-in, ни чужой opt-out). История
не повышается при magic-link verification и не переписывается через UPDATE.

Альтернативы отвергнуты: автоматическая promotion при email verification не
доказывает автора checkbox; новый registration service/ledger в этом fix избыточен.
Authenticated reaffirmation UI/event model и erasure/restore ledger — отдельные
инженерные gaps до активации, не притворный PASS и не новое юридическое согласование.
Фокусные реальные SQLite/auth/campaign regressions + exact-head CI обязательны;
live schema22/runtime сохраняются без deployment и применения migration23.
