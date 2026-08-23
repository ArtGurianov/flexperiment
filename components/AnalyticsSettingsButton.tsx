"use client";

import { useEffect, useState } from "react";
import {
  ANALYTICS_CONSENT_CHANGE_EVENT,
  readAnalyticsConsent,
  requestAnalyticsSettings,
} from "@/components/analytics-consent-client";
import type { AnalyticsConsent } from "@/lib/analytics-consent";

export default function AnalyticsSettingsButton({ className }: { className?: string }) {
  const [consent, setConsent] = useState<AnalyticsConsent>("UNDECIDED");

  useEffect(() => {
    const synchronize = () => setConsent(readAnalyticsConsent());
    synchronize();
    window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, synchronize);
    return () => window.removeEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, synchronize);
  }, []);

  if (consent === "UNDECIDED") return null;

  return (
    <button
      type="button"
      className={className}
      onClick={() => requestAnalyticsSettings()}
    >
      Настройки cookies
    </button>
  );
}
