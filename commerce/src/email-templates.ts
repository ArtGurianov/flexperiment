const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const orderReference = (payload: Record<string, unknown>) => payload.public_order_number ? `\nНомер заказа: ${String(payload.public_order_number)}` : "";

export function renderEmailTemplate(template: string, payload: Record<string, unknown>) {
  if (template === "ticket") {
    const ticketUrl = String(payload.ticket_url ?? "");
    return { subject: "Ваш билет на мастер-класс ФЛЭКСПЕРИМЕНТ", plaintext: `Ваш билет: ${ticketUrl}${orderReference(payload)}`, html: `<p>Ваш билет на мастер-класс ФЛЭКСПЕРИМЕНТ.</p><p><a href="${escapeHtml(ticketUrl)}">Открыть билет</a></p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  }
  if (template === "booking-cancelled") return { subject: "Бронирование отменено", plaintext: `Ваше бронирование отменено. Мы свяжемся с вами по дальнейшим шагам.${orderReference(payload)}`, html: `<p>Ваше бронирование отменено. Мы свяжемся с вами по дальнейшим шагам.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  if (template === "occurrence-cancelled") return { subject: "Мастер-класс отменён", plaintext: `Мастер-класс отменён. Возврат оставшейся уплаченной суммы инициирован автоматически.${orderReference(payload)}`, html: `<p>Мастер-класс отменён.</p><p>Возврат оставшейся уплаченной суммы инициирован автоматически.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  if (template === "customer-refund-confirmation") {
    const url = String(payload.confirmation_url ?? "");
    return { subject: "Подтвердите отмену участия и возврат", plaintext: `Подтвердите отмену участия и полный возврат: ${url}${orderReference(payload)}`, html: `<p>Подтвердите отмену участия и полный возврат.</p><p><a href="${escapeHtml(url)}">Подтвердить отмену и возврат</a></p><p>Ссылка действует ограниченное время.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  }
  if (template === "customer-refund-confirmed") return { subject: "Отмена участия подтверждена", plaintext: `Отмена участия подтверждена. Возврат передан в обработку.${orderReference(payload)}`, html: `<p>Отмена участия подтверждена.</p><p>Возврат передан в обработку.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
  if (template === "refund-succeeded") return { subject: "Возврат выполнен", plaintext: `Возврат выполнен. Срок зачисления зависит от вашего банка.${orderReference(payload)}`, html: `<p>Возврат выполнен. Срок зачисления зависит от вашего банка.</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
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
