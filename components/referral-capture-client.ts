"use client";

import { commerceApiUrl } from "@/lib/commerce-api";
import { referralCaptureCoordinator } from "./referral-capture-state";
import { storeReferralMarker } from "./referral-marker";

async function checkReferralEligibility(slug: string) {
  const response = await fetch(commerceApiUrl("/v1/public/referrals/eligibility"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (!response.ok) return false;
  return Boolean((await response.json() as { eligible?: boolean }).eligible);
}

/**
 * Called by the global landing component and as checkout's race-safe fallback.
 * The coordinator deduplicates an identical active touch.
 */
export function ensureCurrentReferralCapture() {
  const search = window.location.search;
  // Hash fragments are intentionally excluded: referral touch identity is the
  // App Router location, not an in-page anchor change.
  const observation = `${window.location.pathname}${search}`;
  return referralCaptureCoordinator.ensure(
    search,
    checkReferralEligibility,
    storeReferralMarker,
    observation,
  );
}
