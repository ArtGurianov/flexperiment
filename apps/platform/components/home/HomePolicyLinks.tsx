import Link from "next/link";
import { AnalyticsSettingsButton } from "@/components/analytics/AnalyticsConsent";

export default function HomePolicyLinks({ className }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs ${className ?? ""}`}>
      <Link href="/legal/privacy" className="underline underline-offset-2">Конфиденциальность</Link>
      <AnalyticsSettingsButton />
    </div>
  );
}
