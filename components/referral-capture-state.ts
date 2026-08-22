import { referralTouchFromLocation } from "./referral-marker";

type EligibilityCheck = (slug: string) => Promise<boolean>;
type MarkerWriter = (marker: string) => void;

export function createReferralCaptureCoordinator() {
  let sequence = 0;
  let latestEligibleSequence = 0;
  let activeCount = 0;
  let pending: Promise<void> = Promise.resolve();
  let resolvePending: (() => void) | undefined;
  const beginCapture = () => {
    if (activeCount++ === 0) pending = new Promise((resolve) => { resolvePending = resolve; });
  };
  const finishCapture = () => {
    if (--activeCount === 0) resolvePending?.();
  };

  const capture = async (search: string, checkEligibility: EligibilityCheck, writeMarker: MarkerWriter) => {
    const slug = referralTouchFromLocation(search);
    // Navigation without a referral must not cancel a still-resolving eligible
    // landing touch; its marker remains a functional 30-day attribution.
    if (!slug) return false;
    const touchSequence = ++sequence;
    let eligible = false;
    beginCapture();
    await checkEligibility(slug)
      .then((result) => {
        eligible = result;
        // An invalid candidate never changes the marker. Among eligible
        // candidates, the last navigation touch wins even if responses race.
        if (result && touchSequence > latestEligibleSequence) {
          latestEligibleSequence = touchSequence;
          writeMarker(`v1:${slug}`);
        }
      })
      .catch(() => undefined)
      .finally(finishCapture);
    return eligible;
  };

  const waitForCurrentCapture = async () => {
    // A navigation can start another eligibility request while we await the
    // previous one. Do not let checkout read a stale cookie in that gap.
    let observed: Promise<void>;
    do { observed = pending; await observed; } while (observed !== pending);
  };

  return { capture, waitForCurrentCapture };
}

export const referralCaptureCoordinator = createReferralCaptureCoordinator();
