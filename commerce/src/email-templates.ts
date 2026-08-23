const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const orderReference = (payload: Record<string, unknown>) => payload.public_order_number ? `\nНомер заказа: ${String(payload.public_order_number)}` : "";
const formatKopecks = (value: unknown) => Number.isInteger(value) ? `${Number(value) / 100} ₽` : "";

export function renderEmailTemplate(template: string, payload: Record<string, unknown>) {
  if (template === "ticket") {
    const ticketUrl = String(payload.ticket_url ?? "");
    const occurrence = (payload.occurrence ?? {}) as Record<string, unknown>;
    const venue = occurrence.venue_status === "CONFIRMED"
      ? `${String(occurrence.venue_name ?? "")}, ${String(occurrence.venue_address ?? "")}`
      : `${String(occurrence.venue_disclosure_text ?? "Площадка будет объявлена позже")}${occurrence.venue_announce_by ? `. Объявим не позднее: ${String(occurrence.venue_announce_by)}` : ""}`;
    const amount = formatKopecks(payload.amount_kopecks);
    const eventFacts = occurrence.title ? `\nСобытие: ${String(occurrence.title)}\nГород: ${String(payload.city_title ?? "")}\nДата и время: ${String(occurrence.starts_at ?? "")} (${String(occurrence.timezone ?? "")})\nМесто: ${venue}\nОплачено: ${amount}\nБилет действителен.` : "";
    return { subject: "Оплата подтверждена — ваш билет FLEXPERIMENT", plaintext: `Оплата подтверждена. Ваш билет: ${ticketUrl}${eventFacts}${orderReference(payload)}`, html: `<p>Оплата подтверждена. Ваш билет на мастер-класс FLEXPERIMENT готов и действителен.</p>${occurrence.title ? `<p><strong>${escapeHtml(occurrence.title)}</strong><br/>${escapeHtml(payload.city_title)}<br/>Дата и время: ${escapeHtml(occurrence.starts_at)} · ${escapeHtml(occurrence.timezone)}<br/>Место: ${escapeHtml(venue)}<br/>Оплачено: ${escapeHtml(amount)}</p>` : ""}<p><a href="${escapeHtml(ticketUrl)}">Открыть билет</a></p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  }
  if (template === "booking-cancelled") return { subject: "Бронирование отменено", plaintext: `Ваше бронирование отменено. Мы свяжемся с вами по дальнейшим шагам.${orderReference(payload)}`, html: `<p>Ваше бронирование отменено. Мы свяжемся с вами по дальнейшим шагам.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  if (template === "occurrence-cancelled") return { subject: "Мастер-класс отменён", plaintext: `Мастер-класс отменён. Возврат оставшейся уплаченной суммы инициирован автоматически.${orderReference(payload)}`, html: `<p>Мастер-класс отменён.</p><p>Возврат оставшейся уплаченной суммы инициирован автоматически.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  if (template === "customer-refund-confirmation") {
    const url = String(payload.confirmation_url ?? "");
    return { subject: "Подтвердите отмену участия и возврат", plaintext: `Подтвердите отмену участия и полный возврат: ${url}${orderReference(payload)}`, html: `<p>Подтвердите отмену участия и полный возврат.</p><p><a href="${escapeHtml(url)}">Подтвердить отмену и возврат</a></p><p>Ссылка действует ограниченное время.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  }
  if (template === "customer-refund-confirmed") return { subject: "Отмена участия подтверждена", plaintext: `Отмена участия подтверждена. Возврат передан в обработку.${orderReference(payload)}`, html: `<p>Отмена участия подтверждена.</p><p>Возврат передан в обработку.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  if (template === "refund-succeeded") {
    const full = payload.fulfillment_outcome === "FULL";
    const message = full
      ? "Возврат выполнен полностью. Участие и билет аннулированы. Срок зачисления зависит от вашего банка."
      : "Возврат выполнен частично. Ваше участие и билет остаются действительными. Срок зачисления зависит от вашего банка.";
    return { subject: "Возврат выполнен", plaintext: `${message}${orderReference(payload)}`, html: `<p>${escapeHtml(message)}</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  }
  if (template === "occurrence-updated") {
    const before = (payload.before ?? {}) as Record<string, unknown>;
    const after = (payload.after ?? {}) as Record<string, unknown>;
    const changed = Array.isArray(payload.material_changes) ? payload.material_changes.map((value) => String((value as Record<string, unknown>).kind ?? (value as Record<string, unknown>).field)).join(", ") : "";
    const refund = payload.organizer_change_full_refund_available === true
      ? "Из-за существенного изменения до начала события для вашего заказа доступен полный возврат; оформить его можно через страницу возврата."
      : "Пожалуйста, проверьте обновлённые условия участия.";
    return { subject: "Изменились условия мастер-класса FLEXPERIMENT", plaintext: `Изменились условия: ${changed}\nБыло: ${String(before.starts_at ?? "")} · ${String(before.timezone ?? "")}\nСтало: ${String(after.starts_at ?? "")} · ${String(after.timezone ?? "")}\n${refund}${orderReference(payload)}`, html: `<p>Для вашего мастер-класса изменились условия: ${escapeHtml(changed)}.</p><p><strong>${escapeHtml(after.title ?? "FLEXPERIMENT")}</strong><br/>Было: ${escapeHtml(before.starts_at)} · ${escapeHtml(before.timezone)}<br/>Стало: ${escapeHtml(after.starts_at)} · ${escapeHtml(after.timezone)}<br/>Текущая площадка: ${escapeHtml(after.venue_status === "CONFIRMED" ? `${String(after.venue_name ?? "")}, ${String(after.venue_address ?? "")}` : after.venue_disclosure_text ?? "Площадка будет объявлена позже")}</p><p>${escapeHtml(refund)}</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  }
  if (template === "city-interest-available") {
    const city = escapeHtml(payload.city_title);
    const title = escapeHtml(payload.occurrence_title);
    const startsAt = escapeHtml(payload.starts_at);
    return {
      subject: `FLEXPERIMENT появился в ${String(payload.city_title ?? "вашем городе")}`,
      plaintext: `Вы просили сообщить, когда FLEXPERIMENT появится в ${String(payload.city_title ?? "выбранном городе")}. Запланирован мастер-класс «${String(payload.occurrence_title ?? "FLEXPERIMENT")}» (${String(payload.starts_at ?? "дата уточняется")}).`,
      html: `<p>Вы просили сообщить, когда FLEXPERIMENT появится в ${city}.</p><p>Запланирован мастер-класс «${title}».</p><p>Дата и время: ${startsAt}</p>`,
    };
  }
  throw new Error(`Unknown code-owned email template: ${template}`);
}
