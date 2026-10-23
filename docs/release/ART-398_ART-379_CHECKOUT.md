# ART-398 / ART-379 checkout rollout plan

Status: source implementation and local/CI qualification only. This plan has not been executed. It does not authorize merge, installation, financial activation or public sales. Reviewed implementation baseline: `f37de00d0c0a38f3fb5aaa0a8a6d212d5fab001f`; a release must pin its own final source/image identities and successful exact-source CI, independently of its controller SHA.

## Migration 0036 is part of the candidate

The Commerce image must include `0036_checkout_audit_indexes.sql` and its matching `migration.lock` entry, plus the reviewed schema admission in `erasure-restore.ts` and `pd-retention.ts`. Previous 0001–0035 SQL and lock hashes remain unchanged. Migration 0036 adds only:

- `audit_checkout_action_subject` on existing audit action/subject fields;
- `audit_purchase_provider_identity` on the existing qualified-payment identity, restricted to PURCHASE_QUALIFIED evidence.

Both indexes are nonunique: migration does not rewrite/delete evidence, grant access or create a payment. The resulting full schema digest is `089392a156085ce6e353b0998cbd53a75c1d08ecda7f604787532c0f1b096221`; it adds no personal-data store, field or erasure/retention target. Unknown schema changes remain refused.

`server.ts` runs `migrateV2` before erasure preparation, traffic and timers; pending migrations and their journal records commit in an immediate transaction. An isolated rehearsal must measure index-build time on a representative audit volume and reserve the database write-lock/startup interval. Small fixture timing is not a live-volume estimate.

## Admission and rehearsal before an execution GO

1. Record the intended environment, current installed images/source, SQLite lineage and complete migration journal; classify any existing paused operation or recovery before choosing a target. V1 remains retired. Do not reuse a historical proposal's pinned source/images as this candidate.
2. Pin the candidate Commerce, Platform and LAB/proxy artifacts to verified immutable identities; require green test/docker-build for the exact source. Include the LAB exact restart route. Keep controller and application identities separate. Preserve the current owner storefront CLOSED state and current payment/profile admission settings through installation.
3. Preserve a WAL-consistent encrypted backup and independent remote SHA readback under the existing [V2 backup contract](COMMERCE_V2_BACKUPS.md). Rehearse on an isolated restored copy, with no production mounts, workers, mail, bank calls or exposed ingress.
4. In that copy, apply the candidate through its normal migration path. Verify unchanged preexisting financial/audit evidence, immutable migration digests, new journal entry/index definitions, integrity/FK checks and indexed query plans. Verify rerunning migration is a no-op. Run the exact-schema erasure/offline-retention and [restore reconciliation](COMMERCE_V2_RESTORE_RECONCILIATION.md) checks with independently verified erasure authority; unknown state must still refuse admission. Current full source regressions cover these invariants; live-volume rehearsal remains required.

## Bounded installation and independent readback

After a separately authorized environment-specific execution GO, use that environment's reviewed V2 installation/recovery procedure and retained exact image descriptors. Drain/stop competing SQLite writers and preserve existing volumes, erasure inputs and secrets. Install the coherent candidate containing migration 0036 and its exact-schema readers; do not create a new database or manually edit the migration journal. Restore runtime admission only through normal verified erasure preparation, never by manually opening the fence.

Read back actual source/image identities, migration journal/digest, both index definitions, integrity/FK status, current erasure admission and owner storefront settings. Verify original records survived, candidate services are healthy, the exact guest restart route is admitted only on LAB, and create no real payment as an installation smoke test. Take a fresh candidate-source backup and prove isolated restore before treating backup/recovery qualification as complete. Record each result separately from CI.

On migration/boot/identity/authority uncertainty, stop dependent actions and retain the database, journal and receipts for the applicable recovery procedure. Do not drop indexes, rewrite migration history, restore an older database over new financial facts or infer a rollback target from current main. A code rollback, if separately admitted, must be assessed against the current durable schema/evidence; it is not an implicit database downgrade.

## Financial and storefront acceptance remains separate

Installation does not open either owner storefront or admit a Refref profile. The published v9 purchase contract still has no served HTTP transport; ART-400/412 and real provider/storefront E2E remain separate gates. LMS/LAB acceptance must independently cover resolution, explicit legal acceptance/payment, reload/back navigation, definitive refusal, delayed qualification, guest repeat purchase, ticket/history/refund recovery and original-deadline expiry after schema-invalid responses.

No host state is changed by documenting this plan: CUSTODY_IMPACT: NO. An eventual execution that changes host state must separately classify custody under the repository's infrastructure contract and retain its installation/backup evidence.
