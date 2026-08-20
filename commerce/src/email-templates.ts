const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function renderEmailTemplate(template: string, payload: Record<string, unknown>) {
  if (template === "ticket") {
    const ticketUrl = String(payload.ticket_url ?? "");
    return { subject: "Ваш билет на мастер-класс ФЛЭКСПЕРИМЕНТ", plaintext: `Ваш билет: ${ticketUrl}`, html: `<p>Ваш билет на мастер-класс ФЛЭКСПЕРИМЕНТ.</p><p><a href="${escapeHtml(ticketUrl)}">Открыть билет</a></p>` };
  }
  if (template === "booking-cancelled") return { subject: "Бронирование отменено", plaintext: "Ваше бронирование отменено. Мы свяжемся с вами по дальнейшим шагам.", html: "<p>Ваше бронирование отменено. Мы свяжемся с вами по дальнейшим шагам.</p>" };
  if (template === "refund-succeeded") return { subject: "Возврат оформлен", plaintext: "Возврат оформлен. Срок зачисления зависит от вашего банка.", html: "<p>Возврат оформлен. Срок зачисления зависит от вашего банка.</p>" };
  throw new Error(`Unknown code-owned email template: ${template}`);
}
