import { connection } from "next/server";

/** FLEX-121 (B): continue an LMS exchange (`/continue?tx=`). Skeleton; never auto-redirects yet. */
export default async function ContinuePage() {
  await connection();
  return (
    <section>
      <h1>Продолжение входа</h1>
      <p>Возвращаем вас к уроку…</p>
    </section>
  );
}
