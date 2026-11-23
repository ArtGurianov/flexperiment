import { requestCabinet, requireSignedIn } from "@/components/cabinet/request";
import { OrdersView } from "@/components/cabinet/views";

/** FLEX-123 order history (read-only): payment and refund state, separate from access. */
export default async function OrdersPage() {
  const cabinet = await requestCabinet();
  const orders = requireSignedIn(await cabinet.orders(), "/orders");
  return <><h1>Заказы</h1><OrdersView result={orders} heading="История заказов" /></>;
}
