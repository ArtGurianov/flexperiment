import { legalEffectiveDate } from "@/lib/legal-release";

export default function LegalEffectiveDate({ effectiveAt }: { effectiveAt: string }) {
  return <time dateTime={effectiveAt}>{legalEffectiveDate(effectiveAt)}</time>;
}

export function LegalLinkDate({ effectiveAt }: { effectiveAt?: string | null }) {
  if (!effectiveAt || !legalEffectiveDate(effectiveAt)) return null;
  return <> (действует с <LegalEffectiveDate effectiveAt={effectiveAt} />)</>;
}
