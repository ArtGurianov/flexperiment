import type { Metadata } from "next";
import RefundConfirm from "./RefundConfirm";

/** Reached only from a one-time link in a refund email — see app/refund. */
export const metadata: Metadata = {
  title: "Подтверждение отмены | FLEXPERIMENT",
  description: "Подтверждение запроса на отмену участия и возврат оплаты FLEXPERIMENT.",
  robots: { index: false, follow: false },
};

export default function RefundConfirmPage() { return <RefundConfirm />; }
