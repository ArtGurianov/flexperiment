import { cabinetOrigins } from "@/components/cabinet/data";
import { requestCabinet, requireSignedIn } from "@/components/cabinet/request";
import { CoursesView, OrdersView, TicketsView } from "@/components/cabinet/views";

/** FLEX-123 cabinet landing: access (courses, tickets) first, payment history separately. */
export default async function CabinetPage() {
  const cabinet = await requestCabinet();
  const profile = requireSignedIn(await cabinet.profile(), "/");
  const [courses, tickets, orders] = await Promise.all([cabinet.courses(), cabinet.tickets(), cabinet.orders()]);
  const origins = cabinetOrigins();
  const name = profile.status === "ok" ? profile.data.displayName : null;
  return (
    <>
      <h1>{name ? `Личный кабинет · ${name}` : "Личный кабинет"}</h1>
      <CoursesView result={courses} platformOrigin={origins.platform} />
      <TicketsView result={tickets} labOrigin={origins.lab} />
      <OrdersView result={orders} heading="Последние заказы" />
    </>
  );
}
