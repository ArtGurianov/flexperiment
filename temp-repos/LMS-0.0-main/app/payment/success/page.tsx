// app/payment/success/page.tsx

import PaymentSuccess from "./_components/PaymentSucess";


interface PageProps {
  searchParams: { enrollmentId?: string };
}

export default function Page({ searchParams }: PageProps) {
  const enrollmentId = searchParams.enrollmentId || "";

  return <PaymentSuccess enrollmentId={enrollmentId} />;
}
