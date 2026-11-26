import { storefrontCheckoutMyOrigin } from "../../../lib/my-storefront";
import { sharedAccountCookie } from "../../../lib/shared-account-session";

export function lessonEntry(path: string) {
  let shared = false;
  try {
    shared = Boolean(sharedAccountCookie(process.env, [process.env.PLATFORM_ORIGIN, process.env.LAB_ORIGIN]));
  } catch {
    // Shared sign-in is optional on public pages. Commerce still validates every access grant.
  }
  return {
    myLogin: shared ? `/auth/lms/start?next=${encodeURIComponent(path)}` : undefined,
    myCheckoutOrigin: storefrontCheckoutMyOrigin(process.env),
  };
}
