# Stage A — owner facts и candidate.1

ART-232 / ART-169 / ART-179 / ART-41 · 11.10.2026.

`OWNER_APPROVAL_RECEIVED`: владелец прямо сообщил финальное утверждение четырёх текстов. Исходные `draft.2` сохранены без изменения байтов. Здесь подготовлены фактические поправки; `CANDIDATE_DELTA_REVIEW_PENDING` относится только к изменённой редакции, не отменяет approval. Активный legal release не опубликован: технические обещания, account settings и consent/erasure qualification ещё не завершены. Owner approval не является заключением юриста.

## Подтверждённые владельцем факты

- Оператор и единственный автор/преподаватель: ИП Гурьянов Арт Артурович, ИНН 420539506224. ОГРНИП 324420500074591 взят из существующего комплекта, свежая выписка не получалась.
- Адрес: 650023, Россия, г. Кемерово, проспект Московский, д. 17, кв. 360. Контакт по ПД/удалению: art@flexperiment.ru. Адрес относится к legal documents, не к telemetry/API аккаунта.
- РКН: `OWNER_CONFIRMED_SUBMITTED / DOCUMENTARY_EVIDENCE_UNAVAILABLE / REGISTRY_VERIFICATION_PENDING`. Владелец подтвердил отправку, подтверждение не выдаётся. Не требуем receipt, не заявляем проверенное включение в реестр, не придумываем дату/номер уведомления.
- Собственный контент и права подтверждены владельцем. Сторонние преподаватели не планируются. Это не аттестация будущих внешних media assets и не подтверждение загрузки видео.
- Flexing 101 создаётся вручную в Payload CMS, первоначально FREE. Реальные sectionRef/lessonRef/videoRef появляются с настоящим содержанием; launch seed не подменяет редакционный процесс.
- Аккаунт/прогресс: во время пользования платформой либо удаление по подтверждённому запросу на art@flexperiment.ru, с конкретными законными исключениями. Это не бессрочный срок tokens, outbox, telemetry или backup. TTL/erasure/restore-suppression ещё не квалифицированы.

## Публичные условия поставщиков — проверено 11.10.2026

Владелец подтвердил работу как клиент по публичным условиям: индивидуальный подписанный договор не является обязательным artefact этой подготовки. Фактические account entity/region/CDN/analytics settings не выводятся из одного брендового URL.

| Сервис / первичный источник | Установлено | Остаётся проверить |
| --- | --- | --- |
| [NotiSend оферта](https://notisend.ru/terms/), [privacy](https://notisend.ru/terms/privacy/) | ООО «НотиСенд», ИНН 7017463828, ОГРН 1197031061963; 634045, Томская область, г. Томск, ул. Мокрушина, д. 9, стр. 16, помещ. 1039. Оферта 11.06.2026 | Соответствие аккаунта, состав/удаление email payload. Privacy владельца аккаунта не автоматически полный перечень порученных операций над student email |
| [Kinescope оферта](https://kinescope.ru/legal/agreement), [соглашение](https://kinescope.ru/legal/terms-and-conditions), [privacy](https://kinescope.ru/legal/privacy-policy) | Российская оферта 09.01.2025: ООО «Кинескоп», ИНН 5010057284, Московская область, г. Дубна, ул. Правды, д. 33, этаж 2, пом. 5; договор предусмотрен через использование сервиса | Реальное account entity, storage/CDN, player analytics. Российский сайт не исключает всех внешних получателей |
| [Яндекс оферта](https://yandex.ru/legal/cloud_oferta/), [DPA](https://yandex.ru/legal/cloud_dpa/ru/), [SmartCaptcha terms](https://yandex.ru/legal/cloud_terms_smartcaptcha/ru/), [notice](https://yandex.ru/legal/smartcaptcha_notice/ru/) | SmartCaptcha связан с облачным договором. Условия допускают обучение/развитие на HTTP-данных, кроме предусмотренного запрета параметром | Проверить параметр запрета и текущие account/service facts. Не утверждаем, что он уже установлен или что требуется бумажный DPA |
| [Cloud.ru self-service оферта](https://cloud.ru/documents/contracts/offer/offer-service-provision), [Evolution](https://cloud.ru/documents/evolution) | ООО «Облачные технологии», ОГРН 5167746080057, Москва, ул. 2-я Звенигородская, д. 28; версия 260918 действует с 28.09.2026. Акцепт в кабинете, без бумажной подписи. П. 3.2 различает технологический доступ и GDPR processor роль | Object Storage account/region и service appendices; encryption не заменяет age purge |
| [Adman документы и оферта](https://adman.com/pages/document/), [паспорт ЦОД](https://adman.com/tech_passport_adman.pdf), [privacy](https://adman.com/privacy_policy_admancom.pdf) | Владелец подтвердил VPS Adman и ЦОД: 630510, Новосибирская область, дп. Кудряшовский, ул. Светлая, 21. Официальный паспорт подтверждает адрес и оператора ООО «Адман», ИНН 7733576655. Публичная оферта предусматривает акцепт регистрацией/оплатой, отдельная бумажная подпись не требуется | Общая privacy также называет Macrocomunidad C.I.P. Urbanización Samara: проверить применимость к конкретному аккаунту/порученным операциям, не объявлять ни передачу student data этому лицу, ни отсутствие всех внешних получателей. Российский ЦОД не доказывает регион Kinescope/CDN/Cloud.ru |
| DNS / owner restore / operational alerts | Mac в РФ подтверждён ранее; Telebuzzy используется для operational references, не student data | Не определяем контрагента DNS по IP; сохраняем раздельный учёт технического хостинга, восстановления и уведомлений |

## Delta и qualification

`REDLINE.diff` сравнивает исходные четыре текста и кандидаты; `manifest.json` содержит обе версии и SHA-256. Изменены реквизиты, approval status, собственное авторство, ручная подготовка курса и account/progress retention. Территория просмотра остаётся явно предложенным уточнением. Технические пометки сохранены, не выданы за выполненные механизмы. **Не импортировать manifest в activateLegalRelease.**

Остаются authenticated consent events/access gate, erasure с независимым ledger/anti-resurrection, category TTL/backup age cap и actual browser/email/video E2E. Публичная регистрация, marketing, F9 и платежи CLOSED. Production, V1, Refref и четыре HTTP403 guards не изменяются.
