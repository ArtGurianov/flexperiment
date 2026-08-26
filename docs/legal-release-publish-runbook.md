# Legal release publish and cutover runbook

This runbook applies to a new immutable Commerce legal release. It does not
replace legal review or authorize a publication on its own.

## Preparation

1. Back up the production SQLite database and record the deployed commit and
   currently active legal release.
2. Keep `commerce/legal/production-manifest.json` on the currently active
   release. Keep the new release only in its versioned draft manifest with
   `PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP`; do not invent a timestamp before
   publication.
3. Deploy the new version-addressed archive assets without changing the
   non-versioned `public/legal/*.md` convenience copies.
4. Fetch every archive URL and verify that its bytes hash to the exact SHA-256
   in the draft manifest.
5. Verify `GET /v1/public/legal-config` and a fresh checkout context still
   report the old active release. Checkout links must therefore still resolve
   to that release's immutable archive URLs.
6. Immediately before any CheckoutFlow deployment, run the read-only active
   release preflight against the production database:
   `pnpm commerce:legal-release:preflight`. It must verify every archive URL
   and SHA-256 from the active manifest; it does not publish or activate a
   legal release.

## Atomic checkout cutover

For an interrupted controlled legal or schema cutover, use the
[legal cutover recovery runbook](runbooks/LEGAL_CUTOVER_RECOVERY.md). It
governs durable-state recovery and replaces any ad-hoc replay of the historical
sequence below.

For the age-band release, use the automated controlled procedure in
[`controlled-production-cutover.md`](controlled-production-cutover.md). Do not
manually pause, publish and reopen step-by-step: the release owner and durable
gate are the authority. The older sequence below remains historical context for
non-automated legal releases only.

This sequence is required whenever a checkout-schema change and a legal release
depend on one another, such as the booking-time participant age band.

1. Pause public sales before routing the new CheckoutFlow. The additive
   migration may be applied while paused because it preserves old orders and
   the old legal release remains active.
2. Deploy the Commerce and static assets that contain the new schema and the
   already verified versioned archives, while `production-manifest.json` still
   names the old active release. Do not reopen sales.
3. Run `COMMERCE_LEGAL_MANIFEST_PATH=commerce/legal/production-manifest.2026-08-25.1.draft.json pnpm commerce:legal-release:publish` once. The durable
   `legal_releases.effective_at` value and `legal_release_publish_events` row
   are the authoritative publication evidence; Commerce atomically deactivates
   the prior release and activates the new one.
4. Record the exact timestamp returned by that publication evidence. Only then
   create and deploy the follow-up immutable source artifact that promotes the
   draft to `production-manifest.json` and carries that exact timestamp. Never
   use a synthetic midnight or placeholder in an active manifest.
5. Confirm `GET /v1/public/legal-config` and a fresh checkout context now
   return the new version and immutable archive URLs. Create a disposable
   checkout context and prove the same release is snapped into the order path.
6. Switch the non-versioned `public/legal/*.md` convenience copies to the
   byte-identical release text, then reopen sales.

Sales remain paused from step 1 through step 6. Thus no checkout can be
created using the new age-band schema with the old legal release, or the old
schema with the new legal release.

## After publication

1. Verify each checkout link and its SHA-256 again.
2. Verify a new checkout records the new legal snapshot while historical order
   evidence still names its original release and hashes.
3. Confirm the static convenience copies are byte-identical to the activated
   release. These copies are never checkout authority.

## Rollback

Immutable archive assets and historical order snapshots are never edited or
deleted. If activation must be reversed before any order accepts the new
release, publish a new explicitly approved release that restores the intended
current terms; do not mutate the released row. If any order has already
accepted the new release, its evidence remains permanently attached to that
version even if a later release supersedes it.
