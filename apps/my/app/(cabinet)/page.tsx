import { connection } from "next/server";

/** FLEX-123 zone: cabinet landing. Skeleton owned by B until FLEX-123 takes over. */
export default async function CabinetPage() {
  await connection();
  return (
    <section>
      <h1>Личный кабинет</h1>
    </section>
  );
}
