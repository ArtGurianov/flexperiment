import { connection } from "next/server";

/** FLEX-123 zone: profile. Skeleton. */
export default async function ProfilePage() {
  await connection();
  return (
    <section>
      <h1>Профиль</h1>
    </section>
  );
}
