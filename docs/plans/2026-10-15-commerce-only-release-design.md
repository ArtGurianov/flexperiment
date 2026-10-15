# ART351 — Commerce-only candidate, independent frontend identity

## Scope and choice

PR228 is merged as `b5d902b475b4b7a49ab6be52efe53eae6ff555a1`.
Its merged-main Test run38688121047 passed both jobs. Owner authorized merge
and artifact preparation; live recovery/deployment remains HOLD. This change
prepares observation and backup contracts for the separately approved update.

The runtime fix is entirely in Commerce. Three approaches were considered:

1. **Choose:** retain the existing Platform/Admin artifacts, permit independent
   native source identities in the protected release vector, and keep Platform's
   expected Commerce SHA explicit. Each role still requires its exact digest,
   image ID, RootFS, native identity and runtime source.
2. Rebuild Platform from b5 merely to satisfy equal source labels. This adds an
   unnecessary frontend artifact and contradicts the bounded Commerce-only scope.
3. Override Platform's native source label or skip its readback. This would hide
   the actual image identity and is unacceptable.

The only execution-code change removes the equality requirement between the
Commerce and Platform source fields. No schema, application runtime, erasure,
backup transport, deployment command, or workflow changes. The vector is still
an observation contract, never admission authority. Invalid files never fall
back; root0600 custody, immutable role repositories and one vector per process
remain enforced.

## Proposed artifacts (not installed)

`deploy/v2/fast-cut/art-351-commerce-release.json` is the complete candidate:

| Role | Native source | Digest |
| --- | --- | --- |
| Commerce | b5d902b475b4b7a49ab6be52efe53eae6ff555a1 | sha256:d4732e401a79eba2c158df19d23cd42e3314f89c27e5b114d0e8e2ee7e004f79 |
| Platform | 46305e7a422a8239def139dab6e2e28790de3c61 | sha256:653b11e4f307442563297de929614c9e33a5328e78877d2b735b693adcc5a119 |
| Admin | 08523bdf38eeddf5e745ce04d05e1f980a7ced93 | sha256:85eadc71e50fdab0bc4d154a242a46188bd85bbe7f0edfed516f8863eb14dc77 |

Commerce is a private GHCR single linux/amd64 manifest. Independent registry
GET verifies its digest; pull verifies config/image ID, complete RootFS and
native identity. Mac Docker's image ID is the config digest
`sha256:2a52529b787ed7ef3cf0ae5b797fc4105fa27e9c1f9ad5074a3622c1f4b9faa4`.
Target VPS containerd may expose the manifest digest as image ID: qualify its
actual descriptor on that host rather than compare incompatible ID formats.
Full config, RootFS, platform and source still have to match.

On that exact pulled artifact, isolated foundation smoke passed persistence,
restart/replacement, encrypted restore and installation-admission assertions.
The reader46/fence32 tests also passed inside the artifact, network disabled,
read-only filesystem and UID1000. The first extra test invocation failed before
executing tests because Vite attempted a filesystem write; native config loading
and a tmpfs cache fixed the harness. No rebuild or push was repeated.

The local encrypted image archive has SHA256
`db4e4439d5b8ab70a3b4bd36e1662fd46a9242a59080364c5b17a4df5304ef68`,
297243363 bytes. This is artifact custody, not proof of live SQLite recovery,
current Cloud.ru verification or production qualification.

## Required independent readbacks

- Platform's native identity, image and `SOURCE_COMMIT` remain source463. Its
  `/readyz` also reports source463 after verifying the configured Commerce
  upstream. `PLATFORM_EXPECTED_COMMERCE_SHA` must become b5. Retaining the image
  therefore still requires a narrowly authorized Platform env refresh/recreate;
  the current container cannot remain unchanged with its old expected SHA.
- Admin retains source085; its proxied `/readyz` must report the new Commerce
  source b5. These are different identity contracts.
- Commerce native identity, runtime source, readiness, backup filename/status and
  freshness must all report b5. A successful source463 backup is insufficient.
- Regressions accept the split vector, retain frontend references exactly,
  reject Platform-native/source drift or an old expected-Commerce SHA, distinguish
  Platform/Admin readiness, and reject old-Commerce backup receipts. Existing
  real Compose env and nginx tests remain in the same suite.

## Separate owner execution gate

No command in this PR installs inputs, changes the release file or restarts a
service. Before execution, independently review this helper/controller SHA;
keep its identity separate from the b5 Commerce artifact above.

A bounded future owner GO must cover:

1. Fresh read-only preflight: current database/WAL lineage and schema0026,
   published course and the single existing upload, exact current identities,
   remote ledger and installation binding, no owner/ACTIVE/UNKNOWN leases or
   competing writers. Preserve current data; no reset/import/reupload.
2. One current WAL-consistent encrypted backup and independent retrieval/restore
   before runtime mutation. The old04:25 archive predates new course/upload state
   and cannot be restored over it. If admission blocks the runtime backup CLI,
   use the qualified isolated snapshot path; never bypass fencing.
3. Target-host private digest pull and descriptor qualification. Preserve current
   volumes, credentials, ledger/fence/journal and both frontend artifacts.
4. Install the reviewed observation inputs/helper and only the new Commerce
   image/source; refresh only Platform's expected upstream SHA using its retained
   image. Recover admission solely through normal qualified startup, never a
   manual OPEN or automatic restart loop. Stop on any uncertain operation.
5. Independent readbacks: OPEN/current sequence/leases0, schema0026 and preserved
   new course/upload, all role identities/readiness, retired routes404, internal
   Control Room smoke and four external403 guards.
6. A new source-b5 encrypted database backup, remote readback, isolated restore
   and copied-fence proof; verify recurring backups/freshness. Do not accept an
   old SUCCESS status. Only then resume the same upload toward READY/binding,
   actual provider callback and protected browser E2E.

Until that GO, current CLOSED admission is not recovered and live Tus/DRM/E2E
remains stopped. Historical S3 failure cause and real-cloud stability are still
unproven. ART337 stays Done; ART351 and ART338 remain In Progress/HOLD.
Production/V1/Refref, Kinescope configuration, public ingress, payments,
registration, marketing and F9 remain unchanged.
