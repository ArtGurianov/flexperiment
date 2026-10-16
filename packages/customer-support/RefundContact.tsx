/** Shared customer instructions. Financial actions remain in the operator's Admin. */
export function RefundContact() {
  return <section aria-label="Запрос возврата">
    <h3>Запрос возврата</h3>
    <p>Напишите на <a href="mailto:refunds@flexperiment.ru">refunds@flexperiment.ru</a> с почты,
      указанной при покупке. Укажите номер заказа, если он есть, и причину обращения.</p>
    <p>Администратор рассмотрит запрос и сообщит решение. Отправка письма сама по себе не выполняет возврат.</p>
  </section>;
}
