export type AdminErrorPresentation = { message: string; hint?: string };

// Keep operational codes readable without pretending an unknown backend code
// is harmless. The raw code remains visible as the fallback and for support.
const PRESENTATIONS: Readonly<Record<string, AdminErrorPresentation>> = {
  NETWORK_AMBIGUOUS: {
    message: "Связь оборвалась до получения ответа.",
    hint: "Результат команды неизвестен: перечитайте состояние и при необходимости повторите с тем же ключом.",
  },
  IDEMPOTENCY_CONFLICT: {
    message: "Эта команда уже была принята с другим содержимым.",
    hint: "Состояние перечитано. Не создавайте новый ключ, пока не подтвердите, что исходная команда не создала запись.",
  },
  IDEMPOTENCY_CONTRACT_SUPERSEDED: {
    message: "Предыдущая команда использует устаревший контракт.",
    hint: "Состояние перечитано. Не создавайте новый ключ, пока не подтвердите результат исходной команды.",
  },
  IDEMPOTENCY_KEY_INVALID: {
    message: "Ключ идемпотентности имеет неверный формат.",
    hint: "Команда не была начата; повторите её с новым ключом.",
  },
  DRIFT_REVIEW_NOT_OPEN: { message: "Эта drift-проверка уже закрыта другим оператором." },
  RESOLUTION_NOTE_REQUIRED: { message: "Для закрытия drift-проверки укажите причину." },
  PROMO_CODE_ALREADY_EXISTS: { message: "Такой промокод уже существует." },
  AGENT_SLUG_ALREADY_EXISTS: { message: "Такой slug агента уже существует." },
  PROMO_NOT_FOUND: { message: "Промокод не найден." },
  IMMUTABLE_FIELD: { message: "Это поле нельзя изменить после создания." },
  REFUND_AMOUNT_EXCEEDS_AVAILABLE: {
    message: "Сумма возврата больше доступного остатка.",
    hint: "Перечитайте evidence: другой возврат мог уже занять часть суммы.",
  },
  SETTLEMENT_RECOVERY_EXCEEDS_REMAINING: {
    message: "Сумма recovery больше невозвращённого остатка.",
    hint: "Перечитайте settlement и укажите не больше доступного остатка.",
  },
  SETTLEMENT_TRANSITION_FORBIDDEN: {
    message: "Settlement уже перешёл в другое состояние.",
    hint: "Перечитайте settlement перед следующей командой.",
  },
  OCCURRENCE_REVISION_CONFLICT: {
    message: "Событие изменилось у другого оператора.",
    hint: "Данные перечитаны. Сверьте изменения и повторите правку на актуальной версии.",
  },
  CAPACITY_BELOW_OCCUPANCY: {
    message: "Вместимость нельзя сделать меньше уже занятых мест.",
    hint: "Укажите значение не меньше confirmed и reserved бронирований.",
  },
  CONFIRMATION_REQUIRED: { message: "Фраза подтверждения не совпадает." },
  VALIDATION_ERROR: { message: "Проверьте заполнение полей." },
  RATE_LIMITED: { message: "Слишком много запросов. Подождите и повторите." },
  ADMIN_AUTH_REQUIRED: { message: "Сессия закончилась. Войдите снова." },
  ADMIN_REAUTH_REQUIRED: { message: "Для этой команды требуется повторный ввод пароля." },
  PAYMENT_NOT_REFUNDABLE: { message: "Эта оплата больше не допускает компенсационный возврат." },
  PAYMENT_ALREADY_SUCCEEDED: { message: "Оплата уже подтверждена; technical abandonment недоступен." },
  OCCURRENCE_NOT_ENDED: { message: "Событие ещё не завершилось по времени сервера." },
  OCCURRENCE_SALES_MUST_BE_CLOSED: { message: "Перед завершением события закройте продажи." },
  OCCURRENCE_TERMINAL: { message: "Терминальное событие нельзя изменить этой командой." },
  SALES_GATE_REVISION_CONFLICT: { message: "Состояние экстренной остановки уже изменил другой оператор.", hint: "Состояние перечитано. Откройте новое подтверждение с актуальной ревизией." },
};

export const presentAdminError = (code: string): AdminErrorPresentation =>
  PRESENTATIONS[code] ?? { message: `Код backend: ${code}` };
