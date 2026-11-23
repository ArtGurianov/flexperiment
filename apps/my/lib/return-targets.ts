import { MY_CHECKOUT_RETURN_PATH } from "../../../lib/my-checkout-intent";
/** Mirror of Commerce `validReturnTarget("MY", …)`; both are pinned by
 * docs/plans/fixtures/my-identity/return-targets.json. Invalid ⇒ "/". */
const MY_TARGETS = [/^\/$/, /^\/continue\?tx=[A-Za-z0-9_-]{22}$/, /^\/orders$/, /^\/profile$/, /^\/courses$/, /^\/tickets$/, MY_CHECKOUT_RETURN_PATH];

export function validMyReturnTarget(value: unknown): string {
  return typeof value === "string" && value.length <= 256 && MY_TARGETS.some((rule) => rule.test(value)) ? value : "/";
}
