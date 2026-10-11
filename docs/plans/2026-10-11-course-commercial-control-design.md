# ART-169 / ART-165: управление курсом из Payload

## Решение

Сохраняем существующую архитектуру: Payload владеет редакционными course/section/lesson и стабильными refs; Commerce — product/offer, доступом, ценой, правами и checkout. Принимаем предложение владельца управлять FREE/PAID и ценой непосредственно в CMS, но не создаём вторую копию коммерческих данных в Payload. Отклоняем автоматическую цену из title и передачу browser-supplied цены в checkout.

UI-only поле читает свежий Commerce status и отправляет отдельную author-only команду через сервер Payload. Проверяются same-origin, существование сохранённого курса, версия и idempotency key. Actor определяется сессией автора. Секрет сервиса остаётся на сервере. Новая команда создаёт или обновляет canonical ONLINE_COURSE product/offer; saleMode всегда CLOSED. FREE требует 0 копеек, PAID — положительное безопасное целое. Назначение платежа редактируется отдельно, без fallback из названия/профиля.

SQLite immediate transaction связывает CAS, audit и idempotency result. Повтор того же запроса возвращает прежний результат, другой payload с тем же ключом отклоняется. Ошибка cache invalidation после COMMIT не превращает успешную запись в отказ: показывается PENDING. UI подтверждает запись независимым GET; потеря ответа не вызывает слепого нового POST.

## Доступ и смена модели

У FREE нет фиктивного заказа или платёжной попытки. После авторизованного запроса доступного опубликованного урока с реальным video binding Commerce сохраняет отдельное nonfinancial enrollment для verified аккаунта. Проверка eligibility и запись идут под одним SQLite write lock с изменением коммерческой модели. После FREE → PAID этот доступ сохраняется, но не обходит withdrawn, stale projection, unlisted или restrictive override. Paid entitlements и immutable order snapshots не изменяются.

Исторические GRANT_ALLOWED без enrollment нельзя ретроспективно объявить доказанным бесплатным enrollment: при обнаружении такого неоднозначного доступа FREE → PAID блокируется для reconciliation. Migration не заполняет реальные курсы/видео и не генерирует согласия.

## Qualification / ограничения

Regression: service authority, author/Origin, отсутствующий курс, строгие цены, CAS/idempotency, отказ после withdrawal, FREE → PAID с сохранением доступа и отказом новому посетителю, ограничения visibility/override, historical ambiguity, отсутствие orders/checkout_attempts, независимый read-back и смена курса в UI.

## Ручная подготовка Flexing 101

Автор создаёт и сохраняет курс, разделы и уроки в Payload, затем загружает реальные материалы в Kinescope и указывает действительные video refs. В поле «Доступ и цена — Commerce» выбирает FREE и нажимает отдельную кнопку «Сохранить в Commerce». Сервер проверяет сохранённый courseRef и создаёт canonical product/offer с нулевой ценой и закрытыми продажами; UI подтверждает результат свежим read-back. Обычное сохранение редакционного документа не отправляет скрытую коммерческую команду.

Если впоследствии выбран PAID, цена передаётся в целых копейках. Обновление не открывает продажи: paymentPurpose и admission/активация остаются отдельными merchant-controlled настройками. При checkout Commerce читает собственные product/offer, фиксирует immutable snapshot и только затем передаёт его Refref; цена и тип доступа из браузера или дублирующих полей CMS не являются authority. Editorial publishing остаётся существующим projection pipeline и требует настоящих уроков/видео. До квалификации consent/access flow бесплатный курс также не публикуется для регистрации.

PAYMENT_MODE=disabled, marketing=false. Canary preparation продолжает блокировать CMS mutations. Никаких production changes, публикации курса, legal release activation, удаления HTTPS 403 guards или F9. Этот PR — engineering admission, не browser/video E2E.
