/** FLEX-122: presentational checkout. Pure: state in, callbacks out; no fetch, no storage. */
import { useState } from "react";
import type { BuyerStatus, CheckoutKind } from "./buyer-status";
import type { CheckoutNotice, CheckoutReview, CheckoutState, CourseAcceptanceInput, LabAcceptanceInput } from "./checkout-controller";

export type CheckoutActions = {
  confirm: (input: CourseAcceptanceInput | LabAcceptanceInput) => void;
  retry: () => void;
  refreshStatus: () => void;
  openPayment: () => void;
  startOver: () => void;
};

export const formatRub = (kopecks: number) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", minimumFractionDigits: kopecks % 100 ? 2 : 0 }).format(kopecks / 100);

const DOCUMENT_LABELS: Record<string, string> = {
  course_offer: "Условия покупки (оферта)", refund_terms: "Правила возврата", receipt_contact: "Данные для чека",
  fiscal_items: "Фискальные сведения", privacy: "Политика обработки данных", personal_data: "Согласие на обработку персональных данных",
  account_terms: "Правила аккаунта", marketing_consent: "Рекламные сообщения",
};

const NOTICE_TEXT: Record<CheckoutNotice, string> = {
  QUOTE_RENEWED: "Время подтверждения истекло или условия изменились. Проверьте цену ещё раз.",
  DOCUMENTS_CHANGED: "Документы покупки обновились. Ознакомьтесь с ними и подтвердите снова.",
  STATUS_DELAYED: "Статус платежа уточняется. Мы проверим его снова — оплату не нужно повторять.",
  CONFIRM_OUTCOME_UNKNOWN: "Ответ не получен. Повторная проверка не создаст второй платёж.",
  CONFIRM_AGAIN: "Подтверждение не дошло до сервера. Проверьте условия и подтвердите покупку ещё раз.",
};

/** Closed sales (owner: LAB SALES CLOSED; payment mode disabled) read the same on both storefronts. */
const CLOSED_CODES = new Set(["OFFER_CLOSED", "PAYMENTS_DISABLED", "SALES_STOPPED"]);

const UNAVAILABLE_TEXT: Record<string, string> = {
  CONFIRM_OUTCOME_UNKNOWN: "Мы не получили ответ на подтверждение. Повторите проверку — второй платёж не будет создан.",
  OFFER_NOT_AVAILABLE: "Это предложение больше недоступно.",
  OFFER_CLOSED: "Продажи скоро.",
  PAYMENTS_DISABLED: "Продажи скоро.",
  SALES_STOPPED: "Продажи временно приостановлены.",
  ACCEPTANCE_ONLY: "Покупка пока доступна только участникам закрытой проверки.",
  LAB_SOLD_OUT: "Места закончились.",
  LAB_OCCURRENCE_NOT_FOUND: "Это событие больше недоступно.",
  CHECKOUT_STOREFRONT_MISMATCH: "Ссылка на покупку не соответствует предложению. Вернитесь на витрину и начните заново.",
  LEGAL_REVIEW_UNAVAILABLE: "Документы покупки сейчас недоступны, поэтому подтвердить покупку нельзя. Попробуйте позже.",
  CHECKOUT_CONTOUR_NOT_ADMITTED: "Этот способ оформления сейчас недоступен.",
};

const statusText = (kind: CheckoutKind, status: BuyerStatus) => {
  switch (status.payment) {
    case "CONFIRMING": return "Подтверждаем платёж у платёжного провайдера…";
    case "AWAITING_PAYMENT": return "Платёж ожидает завершения.";
    case "ACCESS_GRANTED": return "Оплата подтверждена. Доступ к курсу открыт.";
    case "TICKET_ISSUED": return "Оплата подтверждена. Билет выпущен.";
    case "DECLINED": return kind === "LAB" ? "Платёж отклонён. Место освобождено." : "Платёж отклонён.";
    case "EXPIRED": return kind === "LAB" ? "Время оплаты истекло. Место освобождено." : "Время оплаты истекло.";
    case "SUPPORT_REVIEW": return "Платёж требует проверки поддержкой. Деньги и доступ не потеряются.";
  }
};

const REFUND_TEXT = { REFUND_PROCESSING: "Возврат обрабатывается.", REFUNDED: "Деньги возвращены.",
  SUPPORT_REVIEW: "Возврат требует проверки поддержкой." } as const;

function Review({ review, busy, notice, onConfirm }: { review: CheckoutReview; busy: boolean; notice?: CheckoutNotice;
  onConfirm: CheckoutActions["confirm"] }) {
  const [terms, setTerms] = useState(false);
  const [personalData, setPersonalData] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const lab = review.kind === "LAB";
  const ready = lab ? terms && personalData && receipt : terms;
  return (
    <section aria-labelledby="checkout-title" data-phase="REVIEW" data-kind={review.kind}>
      <h1 id="checkout-title">{lab ? "Билет на событие" : "Покупка курса"}</h1>
      {notice && <p role="status">{NOTICE_TEXT[notice]}</p>}
      {lab && review.occurrence && <p>{[review.occurrence.title, review.occurrence.startsAt && new Date(review.occurrence.startsAt)
        .toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" }), review.occurrence.venue, review.occurrence.city]
        .filter(Boolean).join(" · ")}</p>}
      <dl>
        {review.discountKopecks > 0 && <><dt>Цена</dt><dd>{formatRub(review.baseAmountKopecks)}</dd>
          <dt>Скидка</dt><dd>−{formatRub(review.discountKopecks)}</dd></>}
        <dt>Итого к оплате</dt><dd data-testid="final-amount"><strong>{formatRub(review.finalAmountKopecks)}</strong></dd>
      </dl>
      {review.priceNotice?.code === "PRICE_CHANGED_SINCE_DISPLAY" && review.priceNotice.displayedAmountKopecks !== undefined &&
        <p role="status">Цена изменилась: на витрине было {formatRub(review.priceNotice.displayedAmountKopecks)}, к оплате {formatRub(review.finalAmountKopecks)}.</p>}
      {review.priceNotice?.code === "CATALOG_PRICE_CHANGED_AFTER_QUOTE" &&
        <p role="status">Цена в каталоге изменилась; для этого расчёта сохраняется {formatRub(review.finalAmountKopecks)}.</p>}
      {review.receiptEmail && <p>Электронный чек придёт на {review.receiptEmail}.</p>}
      <h2>Документы покупки</h2>
      <ul>{review.documents.map((document) => <li key={document.kind}>
        <a href={document.url} target="_blank" rel="noopener noreferrer">{DOCUMENT_LABELS[document.kind] ?? "Документ покупки"}</a>
      </li>)}</ul>
      <form onSubmit={(event) => { event.preventDefault(); if (ready) onConfirm(lab
        ? { termsAccepted: terms, personalDataConsent: personalData, receiptContactAccepted: receipt } : { termsAccepted: terms }); }}>
        <label><input type="checkbox" name="terms" checked={terms} disabled={busy} onChange={(event) => setTerms(event.target.checked)} />
          {lab ? " Принимаю условия покупки билета и правила возврата." : " Принимаю условия покупки и правила возврата, ознакомлен(а) с обработкой данных и направлением чека."}</label>
        {lab && <label><input type="checkbox" name="personalData" checked={personalData} disabled={busy}
          onChange={(event) => setPersonalData(event.target.checked)} /> Даю согласие на обработку персональных данных.</label>}
        {lab && <label><input type="checkbox" name="receiptContact" checked={receipt} disabled={busy}
          onChange={(event) => setReceipt(event.target.checked)} /> Согласен(на) получить чек на адрес аккаунта.</label>}
        <button type="submit" disabled={busy || !ready}>{busy ? "Подтверждаем…" : `Подтвердить и оплатить ${formatRub(review.finalAmountKopecks)}`}</button>
      </form>
    </section>
  );
}

export function CheckoutView({ state, actions }: { state: CheckoutState; actions: CheckoutActions }) {
  switch (state.phase) {
    case "LOADING": return <section data-phase="LOADING"><h1>Оформление покупки</h1><p role="status">Проверяем предложение…</p></section>;
    case "SIGN_IN": return <section data-phase="SIGN_IN"><h1>Войдите, чтобы продолжить</h1>
      <p>Выбранное предложение сохранится: после входа вы вернётесь к оформлению.</p><a href={state.href}>Войти по почте →</a></section>;
    case "ACCOUNT_CONFIRMATION": return <section data-phase="ACCOUNT_CONFIRMATION"><h1>Подтвердите аккаунт</h1>
      <p>Билеты на события покупаются только из подтверждённого аккаунта. Войдите по коду из письма, и мы вернём вас сюда.</p>
      <a href={state.href}>Подтвердить почту →</a></section>;
    case "CONSENT_REQUIRED": return <section data-phase="CONSENT_REQUIRED"><h1>Проверьте документы аккаунта</h1>
      <p>Перед покупкой подтвердите актуальные документы аккаунта.</p><a href={state.href}>Открыть профиль →</a></section>;
    case "REVIEW": return <Review review={state.review} busy={state.busy} notice={state.notice} onConfirm={actions.confirm} />;
    case "REDIRECTING": return <section data-phase="REDIRECTING"><h1>Переходим к оплате</h1>
      <p role="status">Открываем страницу платёжного провайдера…</p></section>;
    case "STATUS": return <section data-phase="STATUS" data-payment={state.status.payment} data-kind={state.kind}>
      <h1>Заказ</h1>
      <p role="status">{statusText(state.kind, state.status)}</p>
      {state.status.refund && <p>{REFUND_TEXT[state.status.refund]}</p>}
      {state.notice && <p>{NOTICE_TEXT[state.notice]}</p>}
      {state.status.payment === "SUPPORT_REVIEW" && <p>Номер заказа для поддержки: <code>{state.status.supportReference ?? state.status.orderPublicId}</code></p>}
      {state.status.payment === "AWAITING_PAYMENT" && state.status.paymentUrl && <button type="button" onClick={actions.openPayment}>Перейти к оплате →</button>}
      {state.status.payment === "ACCESS_GRANTED" && <a href="/orders">Мои заказы →</a>}
      {state.status.payment === "TICKET_ISSUED" && <a href="/orders">Мой билет →</a>}
      {(state.status.payment === "DECLINED" || state.status.payment === "EXPIRED") &&
        <button type="button" onClick={actions.startOver}>Оформить заново (новый заказ)</button>}
      {!state.polling && !["ACCESS_GRANTED", "TICKET_ISSUED", "DECLINED", "EXPIRED"].includes(state.status.payment) &&
        <button type="button" onClick={actions.refreshStatus}>Проверить статус</button>}
    </section>;
    case "ALREADY_OWNED": return <section data-phase="ALREADY_OWNED"><h1>{state.kind === "LAB" ? "Билет уже куплен" : "Курс уже ваш"}</h1>
      <a href="/orders">Мои заказы →</a></section>;
    case "ORDER_NOT_FOUND": return <section data-phase="ORDER_NOT_FOUND"><h1>Заказ не найден</h1>
      <p>Этот заказ не принадлежит вашему аккаунту или больше не существует.</p><a href="/orders">Мои заказы →</a></section>;
    case "OFFER_MISMATCH": return <section data-phase="OFFER_MISMATCH"><h1>Предложение изменилось</h1>
      <p>Сервер вернул другое предложение, чем в ссылке. Мы ничего не оформили. Вернитесь на витрину и выберите снова.</p></section>;
    case "UNAVAILABLE": return <section data-phase="UNAVAILABLE" data-code={state.code}><h1>Оформление недоступно</h1>
      <p role="status">{CLOSED_CODES.has(state.code)
        ? (state.kind === "LAB" ? "Продажа билетов на события сейчас закрыта. Заказ не создан, место не резервируется." : "Продажи курса сейчас закрыты. Заказ не создан.")
        : UNAVAILABLE_TEXT[state.code] ?? "Не удалось продолжить оформление. Попробуйте ещё раз."}</p>
      {state.retryable && <button type="button" onClick={actions.retry}>Повторить</button>}</section>;
  }
}
