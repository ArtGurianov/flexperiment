/**
 * The legacy commerce fixtures schedule their occurrence for 2026-10-01T10:00Z. Their domain clock
 * is pinned two hours before it, ahead of the one-hour refund cutoff, so the fixtures mean the
 * same thing on every run instead of expiring when real time passes that date. Tests that
 * exercise a cutoff or a later instant still build their own clock.
 */
export const LEGACY_FIXTURE_NOW = Date.parse("2026-10-01T08:00:00.000Z");
export const legacyFixtureClock = () => LEGACY_FIXTURE_NOW;
