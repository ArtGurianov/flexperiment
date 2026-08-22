"use client";

import { useEffect } from "react";
import { commerceApiUrl } from "@/lib/commerce-api";
import { captureReferralLanding, storeReferralMarker } from "@/components/referral-marker";

export default function ReferralCapture() {
  useEffect(() => {
    void captureReferralLanding(
      window.location.search,
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
  }, []);
  return null;
}
