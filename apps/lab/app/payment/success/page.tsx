import type { Metadata } from "next";
import { Suspense } from "react";

import PaymentStatus from "./PaymentStatus";

/**
 * The post-payment landing page. It is reached only from the payment provider's
 * redirect with an order identifier in the query string, so it has no standalone
 * content — and without its own metadata it inherited the home page's canonical
 * and description, which made it look to a crawler like a duplicate of "/".
 */
export const metadata: Metadata = {
  title: "Статус оплаты | FLEXPERIMENT",
  description: "Статус оформленного заказа FLEXPERIMENT после оплаты.",
  robots: { index: false, follow: false },
};

export default function PaymentSuccessPage() {
  return <Suspense fallback={<main className="min-h-dvh" />}><PaymentStatus /></Suspense>;
}
