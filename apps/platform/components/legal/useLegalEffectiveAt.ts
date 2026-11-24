"use client";

import { useEffect, useState } from "react";
import { currentCoursesLegalPath, legalEffectiveDate, type LegalRelease } from "@/lib/legal-release";

/** A consent screen may still show the preceding release while its action is reconciled. */
export function useLegalEffectiveAt(enabled: boolean, version?: string | null) {
  const [release, setRelease] = useState<Pick<LegalRelease, "version" | "effectiveAt"> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch(currentCoursesLegalPath, {
      cache: "no-store", credentials: "omit", signal: controller.signal,
    }).then(async response => {
      const current = response.ok ? await response.json() as LegalRelease : null;
      if (current && legalEffectiveDate(current.effectiveAt) && !controller.signal.aborted) setRelease(current);
    }).catch(() => { /* An unavailable date does not change a consent action. */ });
    return () => controller.abort();
  }, [enabled, version]);

  return enabled && (version === undefined || release?.version === version) ? release?.effectiveAt : undefined;
}
