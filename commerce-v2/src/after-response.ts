/**
 * Work started after a response has been produced, owned by the process lifecycle (refref docs/29
 * §6): every task is tracked until it settles and the server drains them before it exits. An
 * untracked fire-and-forget Promise does not meet that obligation.
 */
export class AfterResponseTasks {
  private readonly running = new Set<Promise<void>>();
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  schedule(task: () => Promise<void>) {
    const run: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch((error) => { try { this.onError(error); } catch { /* diagnostics never fail a task */ } })
      .finally(() => { this.running.delete(run); });
    this.running.add(run);
  }

  get size() { return this.running.size; }

  /** Waits for every task, including ones scheduled while draining, up to `timeoutMs`. */
  async drain(timeoutMs = Number.POSITIVE_INFINITY) {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.running]),
        ...(Number.isFinite(remaining) ? [new Promise((resolve) => { timer = setTimeout(resolve, remaining); })] : []),
      ]);
      if (timer) clearTimeout(timer);
    }
    return true;
  }
}
