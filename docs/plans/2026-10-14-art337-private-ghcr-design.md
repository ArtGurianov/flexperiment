# ART-337 approved private registry preparation

Owner approved these exact repositories on 2026-10-14:

- ghcr.io/artgurianov/flexperiment-commerce-v2
- ghcr.io/artgurianov/flexperiment-platform-v2
- ghcr.io/artgurianov/flexperiment-admin-v2

The publisher lives in private ArtGurianov/flexperiment-artifacts. Actions uses
its ephemeral GITHUB_TOKEN with contents read and packages write. The public
source repository is checked out separately at exact
08523bdf38eeddf5e745ce04d05e1f980a7ced93. Registry admission checks publisher
privacy, package privacy, current source main and exact-source green CI.
No persistent write token, SSH, VPS or deployment credential enters this repo.

Publish one single-platform linux/amd64 manifest per service and unique run
and attempt tag. Pull by digest independently, verify image ID/RootFS and
native baked identity. Export an image archive, hash it, encrypt it to the
existing owner-held recovery recipient, remove plaintext before upload, and
preserve ciphertext independently before Actions retention expires. Native
Admin release.json is preserved; it is not presented as a Commerce identity.
Full copied-fence/schema26/live recovery remains a separate qualification.

## First attempt and bounded correction

First run38512656998 from public ArtGurianov/flexperiment created packages
with public visibility. The private read-back gate refused; no recovery
archive was uploaded. This follows the GITHUB_TOKEN workflow inheritance
rule; assuming the generic private first-publish default was insufficient.
The source code/image payload contained no live DB or runtime credentials.

Run38513368483 deleted only those three newly created package IDs (15883058,
15883082,15883052), after checking original repo, creation time, single version
and exact unique tag source085-run38512656998-attempt1. Package/version
metadata and delete intent/outcome are retained as evidence. Independent GET
returned404 for all three. No old package or runtime artifact was deleted.
The private publisher recreates the approved names with new private IDs.

The public cleanup workflow is restricted to its original engineering branch
and original IDs; it cannot delete recreated private packages or run on main.
The copied publisher script here permits only the private publisher repository;
it cannot publish from this public source repository.

## Authorization boundary

Owner authorized registry/service preparation only. Both source main and
reviewed PR222 head remain unchanged/unmerged. No journal v3, Coolify resource,
live database/fence/timer, provider setting, canary or production operation.
VPS pull will require an owner-managed read:packages credential under separate
secret installation/execution authorization. Do not use a temporary Actions
token as a durable server credential. Registry publication and CI success are
not ART337 canary admission, installed-image readback, E2E or F9 PASS.
