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

  // D2: legal-profile supersession (post-onboarding change of legal identity).
  AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_BLOCKED_BY_EXISTING_BINDING: {
    message: "Сначала завершите расчёты и другие незавершённые обязательства по текущему партнёрскому профилю.",
    hint: "Это верно и для закрытого engagement'а с незавершённым расчётом.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_STALE: {
    message: "Профиль партнёра уже был изменён после подачи этой заявки.",
    hint: "Заявка помечена устаревшей. Подайте новую при необходимости.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INVALID_STATE: {
    message: "Эта заявка уже обработана и не может быть изменена повторно.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_NO_CHANGE: {
    message: "Новый профиль совпадает с текущим — изменение не требуется.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_ALREADY_PENDING: {
    message: "У партнёра уже есть заявка на изменение юридических данных.",
    hint: "Дождитесь её обработки или отклоните её перед подачей новой.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INELIGIBLE_IDENTITY: {
    message: "Партнёр не может подать заявку на изменение юридических данных в текущем состоянии.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_EVIDENCE_REF_REQUIRED: {
    message: "Для заявки, поданной администратором, укажите ссылку на подтверждающий документ.",
  },
  // PR-E: unified legal requisites matrix validation.
  AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_REQUIRED: {
    message: "Не заполнено обязательное поле юридических реквизитов.",
    hint: "Для выбранной формы (физлицо/ИП/юрлицо) проверьте, что заполнены все обязательные реквизиты.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_FORBIDDEN: {
    message: "Указано поле, недопустимое для выбранной юридической формы.",
    hint: "Например, ОПФ/КПП/юридический адрес применимы только к юридическим лицам.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_INVALID_FORMAT: {
    message: "Неверный формат ИНН, КПП или регистрационного номера.",
    hint: "Проверьте количество цифр: ИНН — 10 (юрлицо) или 12 (физлицо/ИП), КПП — 9, ОГРН — 13, ОГРНИП — 15.",
  },
  AGENT_REFERRALS_SETTLEMENT_LEGAL_PROFILE_BINDING_MISMATCH: {
    message: "Юридическая привязка активации engagement'а не совпадает с текущим профилем партнёра.",
    hint: "Расчёт по этой работе нельзя провести под новой юридической идентичностью.",
  },
  AGENT_REFERRALS_ACTIVATION_BINDING_CORRUPTED: {
    message: "Обнаружено повреждение evidence активации — обратитесь к разработчикам.",
  },
  AGENT_REFERRALS_LEGAL_PROFILE_POINTER_DIVERGED: {
    message: "Обнаружено расхождение в цепочке юридического профиля — обратитесь к разработчикам.",
  },

  // PR-A: the legacy /agents surface may not write a projected legal
  // identity. Reaching these from the admin UI means the card was opened
  // against stale data (the partner's profile changed under it) - the fix
  // is always to re-read, never to resend.
  AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_LOCKED: {
    message: "Тип исполнителя задаётся юридическим профилем партнёра и не меняется на этой карточке.",
    hint: "Карточка перечитана. Чтобы изменить тип, проведите смену юридических данных партнёра в разделе Agent Referrals.",
  },
  AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_DIVERGED: {
    message: "Тип исполнителя разошёлся с юридическим профилем партнёра — обратитесь к разработчикам.",
    hint: "Список агентов не показывается целиком, пока расхождение не устранено: это повреждение данных, а не состояние карточки.",
  },
  AGENT_REFERRALS_LEGAL_IDENTITY_PROJECTION_LOCKED: {
    message: "Наименование и ИНН задаются юридическим профилем партнёра и не меняются на этой карточке.",
    hint: "Карточка перечитана. Реквизиты изменяются сменой юридических данных партнёра в разделе Agent Referrals.",
  },

  // PR-F: tax/VAT treatment authority.
  AGENT_REFERRALS_TAX_TREATMENT_NPD_IS_SYSTEM_DERIVED: {
    message: "НПД фиксируется автоматически вместе с юридическим профилем и не может быть указан вручную.",
  },
  AGENT_REFERRALS_TAX_TREATMENT_EVIDENCE_REF_REQUIRED: { message: "Укажите ссылку на подтверждающий документ." },
  AGENT_REFERRALS_TAX_TREATMENT_REASON_REQUIRED: { message: "Укажите причину." },
  AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_REQUIRED: { message: "Укажите дату, с которой действует налоговый режим." },
  AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID: { message: "Некорректная дата, с которой действует налоговый режим." },
  AGENT_REFERRALS_TAX_TREATMENT_PSN_REQUIRES_INDIVIDUAL_ENTREPRENEUR: {
    message: "ПСН доступна только для индивидуального предпринимателя.",
    hint: "Проверьте текущую организационно-правовую форму партнёра.",
  },
  AGENT_REFERRALS_TAX_TREATMENT_MATRIX_REJECTED: {
    message: "Недопустимое сочетание системы налогообложения и НДС.",
    hint: "Например, для АУСН доступно только «Без НДС», а НПД фиксируется автоматически.",
  },
  AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_REQUIRED: { message: "Для «Без НДС» нужно указать основание освобождения." },
  AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_FORBIDDEN: { message: "Основание освобождения указывается только вместе с «Без НДС»." },
  AGENT_REFERRALS_TAX_TREATMENT_MISSING: {
    message: "Для текущего юридического профиля партнёра ещё не зафиксирован налоговый режим.",
    hint: "Зафиксируйте налоговый режим на странице партнёра перед подготовкой расчёта.",
  },
  AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT: {
    message: "Обнаружено расхождение в цепочке налогового режима — обратитесь к разработчикам.",
  },
};

export const presentAdminError = (code: string): AdminErrorPresentation =>
  PRESENTATIONS[code] ?? { message: `Код backend: ${code}` };
