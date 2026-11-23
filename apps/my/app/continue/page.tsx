import { connection } from "next/server";
import ExchangeForm from "@/components/ExchangeForm";
import SignInForm from "@/components/SignInForm";
import { commerceForBrowser } from "@/lib/commerce-server";

/** FLEX-121 (B): `/continue?tx=` — finish the LMS exchange started on flexperiment.ru.
 * Live MY session ⇒ no code is asked for; otherwise the ordinary my sign-in, then back here.
 * A closed, expired or unknown exchange ends here with a link, never an automatic redirect. */
const TX = /^[A-Za-z0-9_-]{22}$/;
type Described = { status: "STARTED" | "ISSUED" | "CLOSED"; target: { path: string }; signedIn: boolean };

export default async function ContinuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const raw = (await searchParams).tx;
  const tx = typeof raw === "string" && TX.test(raw) ? raw : null;
  const platform = process.env.PLATFORM_ORIGIN?.trim() || "http://localhost:3001";
  if (!tx) return <Ended text="Ссылка для продолжения недействительна." href={platform} />;

  const described = await commerceForBrowser(`/v1/my/exchange/${tx}`);
  if (!described?.ok) return <Ended text="Попытка входа не найдена или устарела." href={platform} />;
  const exchange = await described.json() as Described;
  const back = new URL(exchange.target.path, platform).toString();
  if (exchange.status === "CLOSED") return <Ended text="Эта попытка входа уже завершена." href={back} />;

  if (!exchange.signedIn) return (
    <section>
      <h1>Войдите, чтобы открыть урок</h1>
      <SignInForm next={`/continue?tx=${tx}`} captchaSiteKey={process.env.SMARTCAPTCHA_SITE_KEY?.trim() || undefined} />
    </section>
  );

  const issued = await commerceForBrowser(`/v1/my/exchange/${tx}/issue`, { method: "POST" });
  if (!issued?.ok) return <Ended text="Не удалось продолжить вход. Вернитесь к уроку и попробуйте снова." href={back} />;
  const { code, redeemUrl } = await issued.json() as { code: string; redeemUrl: string };
  return (
    <section>
      <h1>Продолжение входа</h1>
      <ExchangeForm action={redeemUrl} tx={tx} code={code} cancelTo={back} />
    </section>
  );
}

function Ended({ text, href }: { text: string; href: string }) {
  return (
    <section>
      <h1>Продолжение входа</h1>
      <p>{text}</p>
      <p><a href={href}>Вернуться на flexperiment.ru</a></p>
    </section>
  );
}
