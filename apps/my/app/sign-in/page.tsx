import { connection } from "next/server";

/** FLEX-120 (B): OTP sign-in. Skeleton; the form lands with the FLEX-120 UI commit. */
export default async function SignInPage() {
  await connection();
  return (
    <section>
      <h1>Вход в Flexperiment</h1>
      <p>Введите адрес почты — мы пришлём код входа. Если аккаунта ещё нет, он будет создан.</p>
    </section>
  );
}
