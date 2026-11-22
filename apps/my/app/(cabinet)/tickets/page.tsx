import { cabinetOrigins } from "@/components/cabinet/data";
import { requestCabinet, requireSignedIn } from "@/components/cabinet/request";
import { TicketsView } from "@/components/cabinet/views";

/** FLEX-123 «Мои билеты»: list and entry point only. Ticket view, QR, reissue, check-in — FLEX-60/FLEX-84. */
export default async function TicketsPage() {
  const cabinet = await requestCabinet();
  const tickets = requireSignedIn(await cabinet.tickets(), "/tickets");
  return <><h1>Мои билеты</h1><TicketsView result={tickets} labOrigin={cabinetOrigins().lab} heading="Билеты LAB" /></>;
}
