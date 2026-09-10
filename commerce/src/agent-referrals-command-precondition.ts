/**
 * PR-C2: the shared proof behind every `STALE_BOUND` classification in
 * docs/design/AGENT_REFERRALS_COMMAND_REPLAY_MATRIX.md.
 *
 * The obligation is
 *
 *     A commits, its response is lost,
 *     ANY legally possible sequence B* occurs,
 *     old A is retried
 *     -> old A must never mutate authority or evidence created after A.
 *
 * A command that names the aggregate version it was authored against meets
 * that by construction: after B the named version is no longer current, so
 * the retry is refused instead of applied to state it never saw.
 *
 * THE PINNED VALUE MUST BE MONOTONE - a counter that only increases, or the
 * id of the newest row in an append-only chain. A pin on the aggregate's
 * current STATE is not a proof and must never be routed through here:
 * A -> B -> A returns a cyclic state to exactly the value A was authored
 * against (a distribution required for removal, claimed, then required
 * again; a draft edited and edited back), so a stale retry passes the check
 * and applies anyway. That is the same trap as comparing the candidate to
 * the current row, wearing a different hat.
 */

export class AgentReferralsCommandPreconditionError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * Normalizes the two shapes a pin arrives in - "no predecessor yet" is null,
 * never "" or 0-as-absent.
 *
 * The sentinel is written as the ESCAPE `\u0000`, not as a literal NUL byte.
 * It shipped as a literal one by accident, which changed nothing at runtime -
 * both sides of every comparison go through this same function - but made the
 * file binary to git: diffs became unreadable, and the release candidate
 * author refuses a binary path outright, correctly.
 */
const normalize = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "\u0000none" : String(value);

/**
 * Proves the command was authored against the version that is still
 * current. Call it INSIDE the command's own transaction, before any
 * mutation - outside it, a concurrent writer lands between the check and
 * the write and the proof is worth nothing.
 *
 * `observed` is what the caller says it saw; `current` is what the
 * aggregate carries right now. Both null means "nothing existed then and
 * nothing exists now", which is the legitimate first-write case.
 */
export const requireObservedVersion = (
  code: string,
  observed: string | number | null | undefined,
  current: string | number | null | undefined,
): void => {
  if (normalize(observed) !== normalize(current)) {
    throw new AgentReferralsCommandPreconditionError(code, 409, `observed=${observed ?? "none"} current=${current ?? "none"}`);
  }
};
