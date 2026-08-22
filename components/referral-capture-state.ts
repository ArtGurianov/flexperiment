import { referralTouchFromLocation } from "./referral-marker";

type EligibilityCheck = (slug: string) => Promise<boolean>;
type MarkerWriter = (marker: string) => void;

export function createReferralCaptureCoordinator() {
  let sequence = 0;
  let latestEligibleSequence = 0;
  let activeCount = 0;
  const activeByMarker = new Map<string, Promise<boolean>>();
  let pending: Promise<void> = Promise.resolve();
  let resolvePending: (() => void) | undefined;
  const beginCapture = () => {
    if (activeCount++ === 0) pending = new Promise((resolve) => { resolvePending = resolve; });
  };
  const finishCapture = () => {
    if (--activeCount === 0) resolvePending?.();
  };

  const ensure = (search: string, checkEligibility: EligibilityCheck, writeMarker: MarkerWriter) => {
    const slug = referralTouchFromLocation(search);
    // Navigation without a referral must not cancel a still-resolving eligible
    // landing touch; its marker remains a functional 30-day attribution.
    if (!slug) return Promise.resolve(false);
    const marker = `v1:${slug}`;
    const active = activeByMarker.get(marker);
    if (active) return active;
    const touchSequence = ++sequence;
    beginCapture();
    const task = Promise.resolve()
      .then(() => checkEligibility(slug))
      .then((result) => {
        // An invalid candidate never changes the marker. Among eligible
        // candidates, the last navigation touch wins even if responses race.
        if (result && touchSequence > latestEligibleSequence) {
          latestEligibleSequence = touchSequence;
          writeMarker(marker);
        }
        return result;
      })
      .catch(() => false)
      .finally(() => {
        activeByMarker.delete(marker);
        finishCapture();
      });
    activeByMarker.set(marker, task);
    return task;
  };

  const waitForCurrentCapture = async () => {
    // A navigation can start another eligibility request while we await the
    // previous one. Do not let checkout read a stale cookie in that gap.
    let observed: Promise<void>;
    do { observed = pending; await observed; } while (observed !== pending);
  };

  return { ensure, waitForCurrentCapture };
}

export const referralCaptureCoordinator = createReferralCaptureCoordinator();
