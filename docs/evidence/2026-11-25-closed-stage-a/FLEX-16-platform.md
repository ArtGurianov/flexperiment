# FLEX-16 · Проверка серверной страницы документов Platform

Draft [PR #310](https://github.com/ArtGurianov/flexperiment/pull/310)

База и исходный HEAD `72b02da924d342e9e2c24b2e5ce73146bdc06d77`

HEAD PR и локальный Platform `3d0fd18de87de14322af5da85158afb2ea02887f`

Серверная страница показывает название, версию документа, дату действия по Москве, SHA-256 и ссылку на точный исходник. Commerce предоставляет `effectiveAt`, а HTML сохраняет полученное значение в атрибуте `datetime`. Ссылки на документы на главной, в форме входа, подтверждении согласий, настройках рассылки и диалоге аналитики показывают дату соответствующей редакции. Формы согласия продолжают использовать точные versioned URL из Commerce.

Next Cache Components может отправить HTTP 200 из статической оболочки до получения результата `notFound()`. Platform разрешает документ в существующем proxy до начала ответа и передаёт данные той же редакции серверной странице. Сбой чтения Commerce возвращает 503. Анонимная страница отсутствующей редакции возвращает HTTP 404, API — 404 `LEGAL_RELEASE_NOT_FOUND`.

| Наблюдение | Результат |
| --- | --- |
| `2026-11-23T20:59:59.999Z` | 23 ноября 2026 г. |
| `2026-11-23T21:00:00.000Z` | 24 ноября 2026 г. |
| Прямой анонимный HTML с браузерным User-Agent | 4 страницы при двух значениях `effectiveAt`, HTTP 200 без Location, исходные UTC значения в HTML |
| Исходные байты | 4 ответа локального HTTPS совпали байт в байт с точными blobs #305, SHA-256 совпали со значениями на страницах |
| Отсутствующая редакция и неизвестный kind | HTTP 404, API `404 LEGAL_RELEASE_NOT_FOUND` |
| Проверки Platform | 212/212 тестов, сборка, typecheck и ESLint прошли |
| SQL | 37 миграций и 22 исторических дерева прошли проверку, diff Commerce и миграций пуст |

GitHub Actions завершил `test` и `docker-build` успешно для этого HEAD. [Run 45437310750](https://github.com/ArtGurianov/flexperiment/actions/runs/45437310750)

## Команды

Checkout точного HEAD PR, Node.js 22, pnpm 10.29.3 и OpenSSL. Нужен архивный файл [legal-ssr.mjs.txt](fixtures/legal-ssr.mjs.txt) (SHA-256 `de73349b87e822e5809e5176f3da7a14dc62a5ac4a8343f6c5d0e34ab551bbd4`). Фикстура читает публичные метаданные из локальной HTTP-заглушки Commerce и раздаёт исходные blobs по локальному HTTPS. Перед сценарными запросами проверяет `/identity` запущенной сборки.

```sh
set -eu
test "$(git rev-parse HEAD)" = 3d0fd18de87de14322af5da85158afb2ea02887f
test "$(git rev-parse HEAD^)" = 72b02da924d342e9e2c24b2e5ce73146bdc06d77
test -z "$(git status --porcelain)"
git cat-file -e ea251ec62408822f275c2570ee8dc58c4a4034eb^{commit}
pnpm install --frozen-lockfile
pnpm platform:build
pnpm platform:typecheck
pnpm exec eslint apps/platform
pnpm platform:test
pnpm commerce-v2:check-migrations
cp "${FLEX_EVIDENCE_DIR:?}/fixtures/legal-ssr.mjs.txt" ../legal-ssr.mjs
node ../legal-ssr.mjs
```

Эксплуатационная проверка закрытого canary и публичная юридическая активация проходят по отдельному допуску. [FLEX-16](https://app.plane.so/art-workspace/browse/FLEX-16/) · [FLEX-75](https://app.plane.so/art-workspace/browse/FLEX-75/)


## Дополнение после ревью · 25 ноября 2026

Новый HEAD draft PR #310 — `7136ddf0ef2ea9ebeedfdf3a4b84a5d91664ad8e`, база та же. SSR использует `proxyCommerce` и общие с API правила закрытого canary. Статус согласия включает `effectiveAt` из той же строки SQLite, что и манифест и документы. Схема и правовые байты не менялись.

Локально прошли 218 тестов Platform, 72 целевых теста Commerce, сборка, typecheck, lint, actionlint, SEO audit и проверка миграций. Браузерная проверка в Chrome подтвердила переход из главной к документу внутри страницы и обработку отсутствующей редакции. Регрессия в CI запускает собранный Next.js и проверяет анонимный HTML и RSC, настоящий HTTP 404/503, смену редакции, исходные байты и игнорирование присланного служебного заголовка. Существующий тест Docker-образа проверяет серверный путь на закрытой синтетической сети. [CI нового HEAD](https://github.com/ArtGurianov/flexperiment/actions/runs/45530486964)

```sh
set -eu
test "$(git rev-parse HEAD)" = 7136ddf0ef2ea9ebeedfdf3a4b84a5d91664ad8e
export SOURCE_COMMIT="$(git rev-parse HEAD)"
PLATFORM_ORIGIN=https://build.invalid DEPLOY_ENV=staging pnpm platform:build
node apps/platform/scripts/legal-smoke.mjs
pnpm platform:typecheck
pnpm platform:test
pnpm exec vitest run --project node commerce-v2/test/authenticated-consents.test.ts commerce-v2/test/stage-a-preparation.test.ts commerce-v2/test/runtime-backup.test.ts commerce-v2/test/erasure-restore.test.ts commerce-v2/test/campaigns.test.ts
pnpm commerce-v2:check-migrations
```

На точном HEAD после ревью GitHub Actions завершил `test` и `docker-build` успешно. В обоих заданиях прошли соответствующие проверки FLEX-16, включая синтетический canary из собранного образа.

## Кэш даты у справочной ссылки

На `a652301b95912f787b8a9188f83fbd08798e8ee3` собранная Platform подтвердила одно общее чтение Commerce для даты на главной и в диалоге аналитики. Первый запрос после 5 секунд запускает фоновое обновление кэша. После 15 секунд запрос ждёт свежие данные. В этот интервал дата у справочной ссылки может отставать от даты открытого документа. При сбое Commerce дата у ссылки может отсутствовать до следующего чтения. Страница документа и формы согласий используют актуальную редакцию независимо от этого кэша. [CI](https://github.com/ArtGurianov/flexperiment/actions/runs/45535323242)
