"use client";

import { useLayoutEffect } from "react";
import { useSearchParams } from "next/navigation";
import { commerceApiUrl } from "@/lib/commerce-api";
import { referralCaptureCoordinator } from "@/components/referral-capture-state";
import { storeReferralMarker } from "@/components/referral-marker";

export default function ReferralCapture() {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  // Start capture before the browser can accept an interaction that opens
  // checkout. The coordinator then makes checkout wait for this request.
  useLayoutEffect(() => {
    void referralCaptureCoordinator.capture(
      search ? `?${search}` : "",
      async (slug) => {
        const response = await fetch(commerceApiUrl("/v1/public/referrals/eligibility"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
        if (!response.ok) return false;
        return Boolean((await response.json() as { eligible?: boolean }).eligible);
      },
      storeReferralMarker,
    );
  }, [search]);
  return null;
}
