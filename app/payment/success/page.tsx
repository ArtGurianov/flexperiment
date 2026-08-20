import { Suspense } from "react";
import PaymentStatus from "./PaymentStatus";

export default function PaymentSuccessPage() {
  return <Suspense fallback={<main className="min-h-dvh" />}><PaymentStatus /></Suspense>;
}
