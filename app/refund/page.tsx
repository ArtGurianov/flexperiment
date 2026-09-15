import type { Metadata } from "next";
import RefundRequest from "./RefundRequest";

/**
 * The title and robots directive were already here; the description is new.
 *
 * Until the root layout stopped declaring page-specific metadata, this route
 * inherited the home page's description, canonical and og:url regardless of the
 * noindex above — a noindex page still emits those tags, and a crawler that
 * follows a link here saw "/" declared as this page's canonical URL.
 */
export const metadata: Metadata = {
  title: "Отмена и возврат | FLEXPERIMENT",
  description: "Форма запроса на отмену участия и возврат оплаты по заказу FLEXPERIMENT.",
  robots: { index: false, follow: false },
};

export default function RefundPage() { return <RefundRequest />; }
