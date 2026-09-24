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
 * How long an issued capability may be spent.
 *
 * It bounds an unspent capability only: the checkout spends it, and from then
 * on the payment, the refund and cleanup need possession, not freshness. So
 * this is the window between `deploy`/`forward-deploy` handing over (exit 13)
 * and the operator's checkout - minutes in practice (2026-09-24: 5, 6 and 3) -
 * and a backstop for a capability nobody comes back for.
 *
 * It was four hours while an expired capability could strand a session.
 * Revisions now get a same-run reissue, as `-a2` does, so an operator who
 * comes back later is given a new one rather than being locked out, and the
 * window a leaked bearer could be used in is an hour.
 */
export const CERTIFICATION_CAPABILITY_TTL_MS = 60 * 60_000;

/**
 * Who the audit log records for a certification's catalogue commands.
 *
 * A fixed, recognisable actor rather than a real administrator's id: nobody
 * pressed a button, and attributing it to a person would put a machine's
 * action in their name.
 */
export const CERTIFICATION_ADMIN_ID = "certification-service";

