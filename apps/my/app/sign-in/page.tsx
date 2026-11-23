import { connection } from "next/server";
import SignInForm from "@/components/SignInForm";
import { validMyReturnTarget } from "@/lib/return-targets";

/** FLEX-120 (B): OTP sign-in on my. `next` is a validated local my path (contract §7). */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const raw = (await searchParams).next;
  const next = validMyReturnTarget(Array.isArray(raw) ? undefined : raw);
  return (
    <section>
      <h1>Вход в Flexperiment</h1>
      <SignInForm next={next} captchaSiteKey={process.env.SMARTCAPTCHA_SITE_KEY?.trim() || undefined} />
    </section>
  );
}
