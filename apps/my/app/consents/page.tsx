import { connection } from "next/server";
import SignInForm from "@/components/SignInForm";
import { validMyReturnTarget } from "@/lib/return-targets";

export default async function ConsentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const next = validMyReturnTarget((await searchParams).next);
  return <section>
    <h1>Актуальные документы аккаунта</h1>
    <SignInForm next={next} onlyConsent />
  </section>;
}
