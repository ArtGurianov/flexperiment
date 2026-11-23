import { notFound } from "next/navigation";
import CheckoutClient from "@/components/checkout/CheckoutClient";
import { decodeIntentId, validOrderPublicId } from "@/components/checkout/intent";

/** FLEX-122: shared my checkout (`/checkout/<intentId>`, contract B §7). The page only decodes the
 * buyer's offer choice; Commerce decides storefront, price, documents and rights on preview. */
export default async function CheckoutPage({ params, searchParams }: {
  params: Promise<{ intent: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { intent } = await params;
  const offerRef = decodeIntentId(intent);
  if (!offerRef) notFound();
  const { order } = await searchParams;
  return <CheckoutClient intentId={intent} offerRef={offerRef} returnedOrder={validOrderPublicId(order) ? order : null} />;
}
