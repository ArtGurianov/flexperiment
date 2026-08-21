import type { Metadata } from "next";
import RefundRequest from "./RefundRequest";

export const metadata: Metadata = {
  title: "Отмена и возврат | FLEXPERIMENT",
  robots: { index: false, follow: false },
};

export default function RefundPage() { return <RefundRequest />; }
