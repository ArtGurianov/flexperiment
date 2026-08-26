"use client";

import { createPortal } from "react-dom";

import { usePaymentFailure } from "@/components/paymentNoticeStore";

/**
 * The single failure notice for the booking CTAs. Mounted once per page; the
 * triggers themselves only call `showPaymentFailure()`.
 *
 * A fixed banner rather than something inline beside the button that failed:
 * the three CTAs sit in a navbar chip, a panel and a full-width block, and the
 * navbar one has as little as 8px of spare width at 320px, so anything in flow
 * would reflow one of them. The copy names the retry, because the button itself
 * looks unchanged once it leaves its pending state.
 *
 * Portalled to <body> because position:fixed is not sufficient on its own: the
 * navbar carries backdrop-blur, and a backdrop-filter makes that element the
 * containing block for fixed descendants — rendered in place under the navbar
 * CTA, this pinned itself 16px from the bottom of the 53px navbar instead of
 * the viewport. Portalling also puts it outside the loader's inert wrapper,
 * which is correct: it is never shown while the loader is up.
 */
export default function PaymentNotice() {
  const hasFailed = usePaymentFailure();
  if (!hasFailed) return null;

  return createPortal(
    <div
      role="alert"
      className="fixed inset-x-4 bottom-4 z-[90] mx-auto max-w-md border-2 border-acid bg-ink px-4 py-3 text-center font-display text-[0.95rem] leading-snug text-acid"
    >
      Не удалось загрузить форму оплаты. Проверьте соединение и нажмите кнопку
      ещё раз.
    </div>,
    document.body,
  );
}
