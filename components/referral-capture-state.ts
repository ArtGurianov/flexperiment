import { referralTouchFromLocation } from "./referral-marker";

type EligibilityCheck = (slug: string) => Promise<boolean>;
type MarkerWriter = (marker: string) => void;

export function createReferralCaptureCoordinator() {
  let sequence = 0;
  let latestEligibleSequence = 0;
  let activeCount = 0;
  let currentObservation: string | undefined;
  let observationGeneration = 0;
  const activeByTouch = new Map<string, { task: Promise<boolean> }>();
  let pending: Promise<void> = Promise.resolve();
  let resolvePending: (() => void) | undefined;
  const beginCapture = () => {
    if (activeCount++ === 0) pending = new Promise((resolve) => { resolvePending = resolve; });
  };
  const finishCapture = () => {
    if (--activeCount === 0) resolvePending?.();
  };

  const ensure = (search: string, checkEligibility: EligibilityCheck, writeMarker: MarkerWriter, observation = search) => {
    // A distinct location/search is a new navigation touch even when it
    // returns to the same promoter. A no-ref navigation also advances this
    // generation, while deliberately leaving the established cookie intact.
    if (observation !== currentObservation) {
      currentObservation = observation;
      observationGeneration += 1;
    }
    const slug = referralTouchFromLocation(search);
    // Navigation without a referral must not cancel a still-resolving eligible
    // landing touch; its marker remains a functional 30-day attribution.
    if (!slug) return Promise.resolve(false);
    const marker = `v1:${slug}`;
    const touchKey = `${observationGeneration}:${marker}`;
    const active = activeByTouch.get(touchKey);
    if (active) return active.task;
    const touchSequence = ++sequence;
    beginCapture();
    const entry = {} as { task: Promise<boolean> };
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
        // An old task cannot clear a newer touch's active record.
        if (activeByTouch.get(touchKey) === entry) activeByTouch.delete(touchKey);
        finishCapture();
      });
    entry.task = task;
    activeByTouch.set(touchKey, entry);
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
