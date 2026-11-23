# Могут ли FREE-записи вызвать `ERASURE_FINANCIAL_REVIEW_REQUIRED`, и влияет ли это на Stage A

Проверено по коду 2026-11-22: `main` `ff5287a0` и ветка A #291 (`9d8991ca`, не смёржена).

## Вывод

**Нет.** Запись на бесплатный курс не создаёт финансовой связи и не блокирует удаление аккаунта.

- Финансовую проверку запускают только `orders`, `refund_requests`, `course_entitlements`
  (`commerce-v2/src/erasure-restore.ts:131`).
- FREE-запись пишет только `free_course_enrollments` (`playback-access.ts:98` на main; в #291 — явная запись) и,
  в #291, `course_learning_starts`. Обе таблицы — в списке **удаляемых** (`erasure-restore.ts:146-148`; #291 добавляет
  `course_learning_starts` туда же и в `pd-retention`).
- `course_entitlements` создаётся только с `source_order_line_id` (`entitlements.ts:36`) — т. е. из заказа (в том числе
  ручного). FREE→PAID в #291 сохраняет доступ через `free_course_enrollments`, без заказа и без `course_entitlements`.

## Что всё же может остановить удаление у пользователя Stage A

| Случай | Код отказа | Действие по регламенту |
| --- | --- | --- |
| Пользователь участвовал в закрытом платном тесте (есть заказ/возврат/право по заказу) | `ERASURE_FINANCIAL_REVIEW_REQUIRED` | Частичный план: удалить нефинансовое, сохранить минимальную финансовую запись (матрица, строки 7–8) |
| Оператор вручную выдавал доступ (ручной заказ `FX-MANUAL-…`) | `ERASURE_FINANCIAL_REVIEW_REQUIRED` | То же |
| Customer/email упомянут в `audit_log`, `control_room_audit_log` или owner legal evidence | `ERASURE_AUDIT_REVIEW_REQUIRED` | Ручной разбор упоминания; обезличить/сохранить по основанию |

## Влияние на Stage A

- Для обычного бесплатного пользователя удаление проходит штатно → **Stage A не блокируется** этим вопросом.
- Регламент FLEX-131 нужен Stage A для случаев из таблицы выше и для оформления акта/выгрузки (ORDER_179).
- Условие: #291 смёржен с `course_learning_starts` в списке erasure и в обоих fingerprint (G-01) — проверяется в A-7.5.
