import { redirect } from "next/navigation";
import { sharedAccountCookie, sharedLmsReturnHref } from "../../../../lib/shared-account-session";
import { requestCabinet } from "@/components/cabinet/request";
import { connection } from "next/server";
import SignInForm from "@/components/SignInForm";
import { validMyReturnTarget } from "@/lib/return-targets";

/** FLEX-120 (B): OTP sign-in on my. `next` is a validated local my path (contract §7). */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const { next: raw, lmsNext } = await searchParams;
  const next = validMyReturnTarget(raw);
  const shared = sharedAccountCookie(process.env, [process.env.PLATFORM_ORIGIN, process.env.LAB_ORIGIN]);
  const returnToLms = shared ? sharedLmsReturnHref(lmsNext, process.env.PLATFORM_ORIGIN) : null;
  const successHref = returnToLms ?? (next === "/" ? "/profile" : next);
  let onlyConsent = false;
  if (shared) {
    const profile = await (await requestCabinet()).profile();
    if (profile.status === "ok") {
      if (!profile.data.consentRequired) redirect(successHref);
      onlyConsent = true;
    }
  }
  return (
    <section>
      <h1>Вход в Flexperiment</h1>
      <SignInForm next={next} successHref={shared ? successHref : undefined} onlyConsent={onlyConsent} captchaSiteKey={process.env.SMARTCAPTCHA_SITE_KEY?.trim() || undefined} />
    </section>
  );
}
