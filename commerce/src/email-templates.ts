const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const orderReference = (payload: Record<string, unknown>) => payload.public_order_number ? `\nНомер заказа: ${String(payload.public_order_number)}` : "";
const formatKopecks = (value: unknown) => Number.isInteger(value) ? `${Number(value) / 100} ₽` : "";

type OccurrenceSnapshot = Record<string, unknown>;

const formatOccurrenceDateTime = (value: unknown, timezone: unknown) => {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "уточняется";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: String(timezone || "UTC"),
      day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }
};

const venueDescription = (occurrence: OccurrenceSnapshot) => occurrence.venue_status === "CONFIRMED"
  ? [occurrence.venue_name, occurrence.venue_address].filter(Boolean).map(String).join(", ") || "Площадка уточняется"
  : `${String(occurrence.venue_disclosure_text ?? "Площадка будет объявлена позже")}${occurrence.venue_announce_by ? `. Объявим не позднее ${formatOccurrenceDateTime(occurrence.venue_announce_by, occurrence.timezone)}` : ""}`;

const occurrenceFacts = (occurrence: OccurrenceSnapshot) => [
  `Событие: ${String(occurrence.title ?? "FLEXPERIMENT")}`,
  `Дата и время: ${formatOccurrenceDateTime(occurrence.starts_at, occurrence.timezone)} — ${formatOccurrenceDateTime(occurrence.ends_at, occurrence.timezone)} (${String(occurrence.timezone ?? "UTC")})`,
  `Место: ${venueDescription(occurrence)}`,
];

const occurrenceChangeLines = (before: OccurrenceSnapshot, after: OccurrenceSnapshot, values: unknown) => {
  const changes = Array.isArray(values) ? values as Array<Record<string, unknown>> : [];
  const fields = new Set(changes.map((change) => String(change.field)));
  const lines: Array<{ label: string; before: string; after: string }> = [];
  if (fields.has("title")) lines.push({ label: "Название", before: String(before.title ?? "—"), after: String(after.title ?? "—") });
  if (fields.has("starts_at")) lines.push({ label: "Время начала", before: formatOccurrenceDateTime(before.starts_at, before.timezone), after: formatOccurrenceDateTime(after.starts_at, after.timezone) });
  if (fields.has("ends_at")) lines.push({ label: "Время окончания", before: formatOccurrenceDateTime(before.ends_at, before.timezone), after: formatOccurrenceDateTime(after.ends_at, after.timezone) });
  if (fields.has("timezone")) lines.push({ label: "Часовой пояс", before: String(before.timezone ?? "—"), after: String(after.timezone ?? "—") });
  if (["venue_status", "venue_name", "venue_address", "venue_disclosure_text", "venue_announce_by"].some((field) => fields.has(field))) {
    lines.push({ label: "Площадка", before: venueDescription(before), after: venueDescription(after) });
  }
  return lines;
};

export function renderEmailTemplate(template: string, payload: Record<string, unknown>) {
  if (template === "ticket") {
    const ticketUrl = String(payload.ticket_url ?? "");
    const occurrence = (payload.occurrence ?? {}) as Record<string, unknown>;
    const venue = occurrence.venue_status === "CONFIRMED"
      ? `${String(occurrence.venue_name ?? "")}, ${String(occurrence.venue_address ?? "")}`
      : `${String(occurrence.venue_disclosure_text ?? "Площадка будет объявлена позже")}${occurrence.venue_announce_by ? `. Объявим не позднее: ${String(occurrence.venue_announce_by)}` : ""}`;
    const amount = formatKopecks(payload.amount_kopecks);
    const eventFacts = occurrence.title ? `\nСобытие: ${String(occurrence.title)}\nГород: ${String(payload.city_title ?? "")}\nДата и время: ${String(occurrence.starts_at ?? "")} (${String(occurrence.timezone ?? "")})\nМесто: ${venue}\nОплачено: ${amount}\nБилет действителен.` : "";
    const participant = String(payload.participant_name ?? payload.customer_name ?? "Участник");
    const accompaniment = payload.participant_requires_adult_accompaniment === true
      ? "\nУчастник, которому на момент оформления заказа не исполнилось 14 лет, допускается на мастер-класс только в сопровождении совершеннолетнего взрослого, который должен находиться на площадке в течение мероприятия."
      : "";
    return { subject: "Оплата подтверждена — ваш билет FLEXPERIMENT", plaintext: `Оплата подтверждена. Заказчик: ${String(payload.customer_name ?? "")}. Участник: ${participant}. Ваш билет: ${ticketUrl}${eventFacts}${accompaniment}${orderReference(payload)}`, html: `<p>Оплата подтверждена. Ваш билет на мастер-класс FLEXPERIMENT готов и действителен.</p><p>Заказчик: ${escapeHtml(payload.customer_name)}<br/>Участник: ${escapeHtml(participant)}</p>${occurrence.title ? `<p><strong>${escapeHtml(occurrence.title)}</strong><br/>${escapeHtml(payload.city_title)}<br/>Дата и время: ${escapeHtml(occurrence.starts_at)} · ${escapeHtml(occurrence.timezone)}<br/>Место: ${escapeHtml(venue)}<br/>Оплачено: ${escapeHtml(amount)}</p>` : ""}${payload.participant_requires_adult_accompaniment === true ? "<p>Участник, которому на момент оформления заказа не исполнилось 14 лет, допускается на мастер-класс только в сопровождении совершеннолетнего взрослого, который должен находиться на площадке в течение мероприятия.</p>" : ""}<p><a href="${escapeHtml(ticketUrl)}">Открыть билет</a></p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}` };
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
    const before = (payload.before ?? {}) as OccurrenceSnapshot;
    const after = (payload.after ?? {}) as OccurrenceSnapshot;
    const changes = occurrenceChangeLines(before, after, payload.material_changes);
    const refund = payload.organizer_change_full_refund_available === true
      ? "Из-за существенного изменения до начала события для вашего заказа доступен полный возврат; оформить его можно через страницу возврата."
      : "Пожалуйста, проверьте обновлённые условия участия.";
    const plaintextChanges = changes.map((change) => `${change.label}\nБыло: ${change.before}\nСтало: ${change.after}`).join("\n\n") || "Обновлены условия мастер-класса.";
    const htmlChanges = changes.length
      ? `<ul>${changes.map((change) => `<li><strong>${escapeHtml(change.label)}</strong><br/>Было: ${escapeHtml(change.before)}<br/>Стало: ${escapeHtml(change.after)}</li>`).join("")}</ul>`
      : "<p>Обновлены условия мастер-класса.</p>";
    const facts = occurrenceFacts(after);
    return {
      subject: "Изменились условия мастер-класса FLEXPERIMENT",
      plaintext: `Изменились условия участия:\n${plaintextChanges}\n\nАктуальные данные мастер-класса:\n${facts.join("\n")}\n\n${refund}${orderReference(payload)}`,
      html: `<p>Изменились условия участия в мастер-классе.</p>${htmlChanges}<p><strong>Актуальные данные мастер-класса</strong><br/>${facts.map(escapeHtml).join("<br/>")}</p><p>${escapeHtml(refund)}</p>${payload.public_order_number ? `<p>Номер заказа: ${escapeHtml(payload.public_order_number)}</p>` : ""}`,
    };
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
