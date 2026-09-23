/**
 * How long a release waits for what it just deployed to become observable.
 *
 * Coolify answering "finished" is the end of ITS operation: the build ran and
 * the containers were started. It is not the moment the proxy serves the new
 * descriptor, the worker records its first heartbeat or its first sweep
 * completes. Those follow asynchronously, seconds later, and a release that
 * observed exactly once at the instant Coolify answered was racing them. The
 * fourth launch attempt lost that race 41 ms after commerce "finished", and its
 * rollback lost it twice more.
 *
 * So the consumers of that evidence poll it, boundedly. The waiter only ever
 * reads: every poll is a fresh observation, nothing is redeployed or restarted
 * from here, and evidence that is structurally wrong is not waited on at all.
 *
 * Bounded by attempts rather than by a clock. A frozen test clock must not turn
 * a deadline into an infinite loop, and the attempt count is what the deadline
 * means anyway: `deadlineMs / intervalMs` further looks after the first.
 */
export type ConvergencePolicy = {
  readonly deadlineMs: number;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Production: two minutes, at the cadence the Coolify client already polls with. */
export const PRODUCTION_CONVERGENCE: ConvergencePolicy = { deadlineMs: 120_000, intervalMs: 5_000, sleep: realSleep };

/** One look and no wait: what every seam did before, kept as the default for composition that does not opt in. */
export const SINGLE_OBSERVATION: ConvergencePolicy = { deadlineMs: 0, intervalMs: 1, sleep: async () => {} };

/**
 * Polls `probe` until `settled` accepts its answer or the attempts run out.
 *
 * Returns the last answer either way; whether an unsettled one is a failure is
 * the caller's decision, because only the caller knows what it means. A probe
 * that throws is retried only when `transient` says the error is a state of a
 * rollout in progress - anything else is rethrown at once, and so is a
 * transient error still standing when the attempts are spent, so the caller's
 * failure names the last real reason rather than a generic timeout.
 */
export const converge = async <T>(
  policy: ConvergencePolicy,
  probe: () => Promise<T>,
  settled: (value: T) => boolean,
  transient: (error: unknown) => boolean = () => false,
): Promise<T> => {
  const attempts = Math.floor(policy.deadlineMs / policy.intervalMs) + 1;
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= attempts;
    let value: T;
    try {
      value = await probe();
    } catch (error) {
      if (last || !transient(error)) throw error;
      await policy.sleep(policy.intervalMs);
      continue;
    }
    if (last || settled(value)) return value;
    await policy.sleep(policy.intervalMs);
  }
};
