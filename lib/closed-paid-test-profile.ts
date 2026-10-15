/** Non-secret identity of one private ART-39 experiment; never a public-sales activation. */
export const CLOSED_PAID_TEST_PROFILE = "art39-test-course-rub1-v1";
export const CLOSED_PAID_TEST_COURSE = "test-course";
export const CLOSED_PAID_TEST_OFFER = "course:test-course";
export const CLOSED_PAID_TEST_AMOUNT = 100;
type Environment = Readonly<Record<string, string | undefined>>;

export function closedPaidTestEnabled(env: Environment): boolean {
  if (env.CLOSED_PAID_TEST_PROFILE === undefined) return false;
  if (env.CLOSED_PAID_TEST_PROFILE !== CLOSED_PAID_TEST_PROFILE || env.DEPLOY_ENV !== "staging"
    || env.PAYMENT_MODE !== "refref" || env.MARKETING_BROADCASTS_ENABLED !== "false"
    || env.PLATFORM_ORIGIN !== "https://canary-platform.flexperiment.ru"
    || env.LAB_ORIGIN !== "https://canary-lab.flexperiment.ru"
    || env.ADMIN_ORIGIN !== "https://canary-admin.flexperiment.ru"
    || env.API_ORIGIN !== "https://canary-api.flexperiment.ru"
    || env.REFREF_API_BASE_URL !== "https://api.refref.ru/v1-rc"
    || env.REFREF_CHECKOUT_ORIGIN !== "https://checkout.refref.ru"
    || env.REFREF_READINESS_URL !== "https://ops.refref.ru/readyz"
    || !/^[a-f0-9]{64}$/.test(env.CLOSED_PAID_TEST_LEGAL_SHA256 ?? "")
    || !/^[A-Za-z0-9._-]{1,120}$/.test(env.CLOSED_PAID_TEST_LEGAL_VERSION ?? "")
    || !/^[a-f0-9]{40}$/.test(env.CLOSED_PAID_TEST_REFREF_SOURCE ?? "")) {
    throw new Error("CLOSED_PAID_TEST_CONFIG_INVALID");
  }
  return true;
}
