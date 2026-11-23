import { connection } from "next/server";

/** FLEX-123 zone: order history (read-only). Skeleton. */
export default async function OrdersPage() {
  await connection();
  return (
    <section>
      <h1>Заказы</h1>
    </section>
  );
}
