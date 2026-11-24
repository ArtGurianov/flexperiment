import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { commerceForBrowser } from "@/lib/commerce-server";

const orderRef = /^[A-Za-z0-9_-]{8,64}$/;
const png = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export default async function TicketPage({ params }: { params: Promise<{ orderPublicId: string }> }) {
  const { orderPublicId } = await params;
  if (!orderRef.test(orderPublicId)) notFound();

  const response = await commerceForBrowser(`/v1/my/tickets/${orderPublicId}`);
  if (response?.status === 401) redirect("/sign-in?next=%2Ftickets");
  if (response?.status === 404) notFound();
  const ticket = response?.ok ? await response.json().catch(() => null) : null;
  const qr = ticket?.orderPublicId === orderPublicId && ticket.status === "VALID"
    && typeof ticket.qrImage === "string" && ticket.qrImage.length <= 32_768 && png.test(ticket.qrImage)
    ? ticket.qrImage : null;

  return (
    <section>
      <h1>Билет LAB</h1>
      {qr ? <Image src={qr} alt="QR-код билета для входа" width={320} height={320} unoptimized />
        : <p>QR-код билета сейчас недоступен.</p>}
      <Link href="/tickets">Мои билеты</Link>
    </section>
  );
}
