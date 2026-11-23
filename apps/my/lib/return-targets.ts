/** Mirror of Commerce `validReturnTarget("MY", …)`; both are pinned by
 * docs/plans/fixtures/my-identity/return-targets.json. Invalid ⇒ "/". */
const MY_TARGETS = [/^\/$/, /^\/continue\?tx=[A-Za-z0-9_-]{22}$/, /^\/orders$/, /^\/profile$/, /^\/courses$/, /^\/tickets$/, /^\/checkout\/[A-Za-z0-9_-]{16,64}$/];

export function validMyReturnTarget(value: unknown): string {
  return typeof value === "string" && value.length <= 256 && MY_TARGETS.some((rule) => rule.test(value)) ? value : "/";
}
