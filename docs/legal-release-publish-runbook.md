# Legal release publish and cutover runbook

This runbook applies to a new immutable Commerce legal release. It does not
replace legal review or authorize a publication on its own.

## Preparation

1. Back up the production SQLite database and record the deployed commit and
   currently active legal release.
2. Deploy the new version-addressed archive assets without changing the
   non-versioned `public/legal/*.md` convenience copies.
3. Fetch every archive URL and verify that its bytes hash to the exact SHA-256
   in the draft manifest.
4. Verify `GET /v1/public/legal-config` and a fresh checkout context still
   report the old active release. Checkout links must therefore still resolve
   to that release's immutable archive URLs.
5. Immediately before any CheckoutFlow deployment, run the read-only active
   release preflight against the production database:
   `pnpm commerce:legal-release:preflight`. It must verify every archive URL
   and SHA-256 from the active manifest; it does not publish or activate a
   legal release.

## Publish

1. Run the existing explicit `pnpm commerce:legal-release:publish` operation
   with the approved manifest. Never publish a placeholder release.
2. Record the command evidence and the actual publication time. Commerce
   atomically deactivates the previous release and activates the new one.
3. Confirm `GET /v1/public/legal-config` now returns the new version and
   immutable archive URLs. Create a disposable checkout context and confirm it
   contains the same release and archive links.

## After publication

1. Verify each checkout link and its SHA-256 again.
2. Verify a new checkout records the new legal snapshot while historical order
   evidence still names its original release and hashes.
3. Only after these checks may the static convenience copies in
   `public/legal/*.md` be switched to the identical new text. These copies are
   never checkout authority.

## Rollback

Immutable archive assets and historical order snapshots are never edited or
deleted. If activation must be reversed before any order accepts the new
release, publish a new explicitly approved release that restores the intended
current terms; do not mutate the released row. If any order has already
accepted the new release, its evidence remains permanently attached to that
version even if a later release supersedes it.
