import type { Metadata } from "next";
import LabGuestTicket from "../../components/LabGuestTicket";
export const metadata: Metadata = { title: "Билет LAB", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function TicketPage() { return <LabGuestTicket />; }
