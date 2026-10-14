# ART-337: immutable artifact recovery from journal v2 / schema 0026

Engineering authorization only. Live execution remains HOLD. Source stays
`08523bdf38eeddf5e745ce04d05e1f980a7ced93`; the controller is independently
reviewed and remains outside deployment-source ancestry.

## Evidence and alternatives

Coolify deployment `vqdxaybzu5e22xsm6ryaekey` performed another Docker build.
The qualified and installed image IDs and RootFS layer arrays differ. The
original Dockerfiles use mutable base references, apt repositories and build
outputs; reproducibility is not an admission premise. It is unnecessary to
attribute every changed byte to reject the installation.

1. Rebuild and compare: can refuse a mismatch but cannot deliver the already
   qualified artifact. Rejected.
2. Change the existing UUID to Docker Image through the API: installed Coolify
   4.4.6 validates PATCH `build_pack` through BuildPackTypes, which excludes
   `dockerimage`. Rejected; no SQL/model bypass or server upgrade.
3. Create a stopped Docker Image delivery resource through the supported API,
   preserving the original storage directories and network alias. Chosen.
   Native persistent-storage creation prefixes the new UUID, so it cannot
   name the existing volume. Native directory binds instead reference the
   exact Docker volume Mountpoints, checked by name/device/inode. Original
   volumes, UUID and backup history remain in custody. A new UUID is recorded
   in a new append-only admission, never substituted into old evidence.

## Contract

Build once, publish to a registry, resolve a **single linux/amd64 manifest**,
then qualify the image pulled by that digest. Indexes, mutable tags and source
SHA alone do not grant admission. Store manifest digest, config descriptor,
compressed layer descriptors, Docker image ID, uncompressed RootFS layers,
platform and baked identity. Compare all of them after a fresh digest pull
and independently on the running container. No registry credentials in JSON.

A separate v3 journal admits ONLY the reviewed continuation, not another
0025 migration. Its parent is the exact current v2 journal
`3496ccc7d51c691cb65035c6e09b69ac44ef24a1358d2021fc49ae88652a2a0b`.
Preserve the v2 record and its entire history plus new evidence. Fresh online
snapshots, schema 0026 restore, normal runtime recovery on a copied fence,
remote ledger, installation binding, backup read-back and writer isolation
are mandatory. Hold a Commerce BEGIN IMMEDIATE reservation across last
snapshot check, journal publication, fsync and read-back. The original v2
imageId remains in the archived parent.

Resource creation/configuration, journal publication and deployment queueing
have separate immutable intent/outcome records. Any intent without a durable
outcome prevents retry. Reconciliation is read-only; no automatic retry,
rollback or success inferred from a request timeout. No reset, migration to
0025, manual fence open, production change, provider change or new publication.

## Release boundary

The current engineering tests may create local isolated images/registries and
operate on copied SQLite. Live creation of a delivery resource, directory
binds, secret provisioning, namespace/backup binding changes and v3 publication
require a new owner execution GO after exact-head independent review.
Existing owner-rpc remains pinned for v2 validation; the new controller must
not reinterpret its history as if created by the new controller. Final
Platform/Admin digest installations and full cutover gates remain mandatory.
