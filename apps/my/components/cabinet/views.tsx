/* FLEX-123 cabinet views. Pure, synchronous components over closed DTOs: no fetching here.
 * Access (what the customer may open) and payment/refund state (what happened to an order)
 * are rendered in separate sections and never derived from each other. */
import type { ReactNode } from "react";
import {
  ACCESS_LABEL, ORDER_STATE_LABEL, PRODUCT_LABEL, TICKET_STATUS_LABEL,
  formatDate, formatDateTime, formatRub, lmsEntryHref,
  type CabinetCourse, type CabinetOrder, type CabinetProfile, type CabinetTicket, type LoadResult,
} from "./model";

export function StatusNotice({ result, what }: { result: Exclude<LoadResult<unknown>, { status: "ok" }>; what: string }) {
  switch (result.status) {
    case "consent-required":
      return <p className="cabinet-notice" role="status">Чтобы открыть {what}, подтвердите согласия аккаунта на странице <a href="/profile">профиля</a>.</p>;
    case "not-yet-available":
      return <p className="cabinet-notice" role="status">Раздел «{what}» скоро появится в кабинете.</p>;
    case "signed-out":
      return <p className="cabinet-notice" role="status"><a href="/sign-in">Войдите</a>, чтобы увидеть {what}.</p>;
    default:
      return <p className="cabinet-notice" role="status">Не удалось загрузить {what}. Обновите страницу чуть позже.</p>;
  }
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return <section className="cabinet-section" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

export function CoursesView({ result, platformOrigin, heading = "Мои курсы" }: {
  result: LoadResult<CabinetCourse[]>; platformOrigin: string; heading?: string;
}) {
  return (
    <Section title={heading} id="courses-heading">
      {result.status !== "ok" ? <StatusNotice result={result} what="курсы" />
        : result.data.length === 0 ? <p>Здесь появятся курсы после записи или покупки. <a href={`${platformOrigin}/`}>Каталог курсов</a></p>
          : (
            <ul className="cabinet-list">
              {result.data.map((course) => (
                <li key={course.slug} className="cabinet-item">
                  <div>
                    <strong>{course.title}</strong>
                    <p className="cabinet-meta">
                      <span>Доступ: {ACCESS_LABEL[course.access]}</span>
                      {course.started && <span> · Начат</span>}
                    </p>
                  </div>
                  {/* Protected entry is accepted by FLEX-121 (exchange receiver on LMS). */}
                  <a className="cabinet-action" href={lmsEntryHref(platformOrigin, course)}>
                    {course.resumeLesson ? `Продолжить: ${course.resumeLesson.title}` : course.started ? "Продолжить" : "Начать"}
                  </a>
                </li>
              ))}
            </ul>
          )}
    </Section>
  );
}

export function TicketsView({ result, heading = "Мои билеты" }: {
  result: LoadResult<CabinetTicket[]>; heading?: string;
}) {
  return (
    <Section title={heading} id="tickets-heading">
      {result.status !== "ok" ? <StatusNotice result={result} what="билеты" />
        : result.data.length === 0 ? <p>Билетов LAB пока нет.</p>
          : (
            <ul className="cabinet-list">
              {result.data.map((ticket) => {
                const href = ticket.status === "VALID" ? ticket.viewPath : null;
                return (
                  <li key={ticket.orderPublicId} className="cabinet-item">
                    <div>
                      <strong>{ticket.title}</strong>
                      <p className="cabinet-meta">
                        <span>{formatDateTime(ticket.startsAt, ticket.timezone)}</span>
                        {ticket.venueName && <span> · {ticket.venueName}</span>}
                        <span> · {TICKET_STATUS_LABEL[ticket.status]}</span>
                      </p>
                    </div>
                    {/* The ticket view, QR and its authorization belong to FLEX-60 (LAB). */}
                    {href && <a className="cabinet-action" href={href}>Открыть билет</a>}
                  </li>
                );
              })}
            </ul>
          )}
    </Section>
  );
}

export function OrdersView({ result, heading = "Заказы" }: { result: LoadResult<CabinetOrder[]>; heading?: string }) {
  return (
    <Section title={heading} id="orders-heading">
      {result.status !== "ok" ? <StatusNotice result={result} what="заказы" />
        : result.data.length === 0 ? <p>Заказов пока нет.</p>
          : (
            <table className="cabinet-table">
              <thead><tr><th scope="col">Дата</th><th scope="col">Покупка</th><th scope="col">Сумма</th><th scope="col">Оплата и возврат</th></tr></thead>
              <tbody>
                {result.data.map((order) => (
                  <tr key={order.orderPublicId}>
                    <td>{formatDate(order.createdAt)}</td>
                    <td>{order.title} <span className="cabinet-meta">({PRODUCT_LABEL[order.productKind]})</span></td>
                    <td>{formatRub(order.amountKopecks)}</td>
                    <td>{ORDER_STATE_LABEL[order.state]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      <p className="cabinet-meta">Покупки до перехода на новый кабинет обслуживаются по прежнему порядку поддержки.</p>
    </Section>
  );
}

export function ProfileView({ result }: { result: LoadResult<CabinetProfile> }) {
  return (
    <Section title="Профиль" id="profile-heading">
      {result.status !== "ok" ? <StatusNotice result={result} what="профиль" /> : (
        <dl className="cabinet-dl">
          <dt>Почта</dt><dd>{result.data.email}</dd>
          <dt>Имя</dt><dd>{result.data.displayName ?? "Не указано"}</dd>
          <dt>Аккаунт создан</dt><dd>{formatDate(result.data.createdAt)}</dd>
          <dt>Согласия аккаунта</dt><dd>{result.data.consentRequired ? "Требуется подтверждение" : "Действуют"}</dd>
          <dt>Рассылка</dt><dd>{result.data.marketing ? "Подписка оформлена" : "Без рассылки"}</dd>
        </dl>
      )}
    </Section>
  );
}
