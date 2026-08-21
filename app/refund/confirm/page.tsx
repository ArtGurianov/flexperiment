import type { Metadata } from "next";
import RefundConfirm from "./RefundConfirm";

export const metadata: Metadata = {
  title: "Подтверждение отмены | FLEXPERIMENT",
  robots: { index: false, follow: false },
};

export default function RefundConfirmPage() { return <RefundConfirm />; }
