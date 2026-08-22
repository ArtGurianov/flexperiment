"use client";

import { useLayoutEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ensureCurrentReferralCapture } from "@/components/referral-capture-client";

export default function ReferralCapture() {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  // Start capture before the browser can accept an interaction that opens
  // checkout. The coordinator then makes checkout wait for this request.
  useLayoutEffect(() => {
    void ensureCurrentReferralCapture();
  }, [search]);
  return null;
}
