/**
 * What a certification occurrence is, fixed here rather than chosen per run.
 *
 * The title, price and timezone are not inputs. An endpoint that accepted them
 * would let a caller with the service token create an ordinary-looking event in
 * the production catalogue at a price of their choosing; fixing them means the
 * only thing a certification can publish is recognisably a certification.
 *
 * One rouble, one seat: the smallest real payment that still exercises the
 * whole path - provider, webhook, ticket, refund - and the smallest amount to
 * reconcile if a run ends up incomplete.
 */
export const CERTIFICATION_OCCURRENCE_TITLE = "PRODUCTION CERTIFICATION — не для продажи";
export const CERTIFICATION_PRICE_KOPECKS = 100;
export const CERTIFICATION_TIMEZONE = "Europe/Moscow";

/**
 * Who the audit log records for a certification's catalogue commands.
 *
 * A fixed, recognisable actor rather than a real administrator's id: nobody
 * pressed a button, and attributing it to a person would put a machine's
 * action in their name.
 */
export const CERTIFICATION_ADMIN_ID = "certification-service";

/** The customer-side confirmation a certification's own cancellation carries. */
export const CERTIFICATION_CANCELLATION_CONFIRMATION = "Производственная сертификация: отмена собственной брони";
