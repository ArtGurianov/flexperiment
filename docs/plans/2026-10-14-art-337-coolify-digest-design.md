# ART-337: installed Coolify 4.4.6 digest delivery contract

Execution remains HOLD. PR #222 stays unmerged; main/source085, live journal
v2/schema26 and stopped Commerce/Payload remain unchanged.

Use one canonical encoder for the request and both GET checks:
`repository`, `sha256-<hex>`. This is the installed job's explicit digest form.

Alternatives inspected in the actual installed source:

- Full `repository@sha256:<hex>` at creation: the API splits it into name
  `repository@sha256` and bare tag `<hex>`. It can resolve correctly, but would
  violate the previous controller's repository-only GET assumption.
- Bare hash in tag with repository name: the parser similarly rewrites the
  persisted name. The old controller would fail at configuration; it did not
  necessarily request a mutable image on this exact installed version.
- Explicit `sha256-<hex>`: API preserves the two fields and the job resolves
  `repository@sha256:<hex>`. Chosen; no compatibility alias accepted by guards.

Tests must cross the API/job boundary, not just run Docker directly. Capture
read-only installed source with full-file hashes. Replay its actual PHP parser,
API normalization, job image selection, Compose image assignment and Compose
pull/up command construction; stub only persistence/SSH/other infrastructure.
Feed the real controller create request into this replay. Execute its Compose
commands against an isolated registry/container and independently compare the
result to the qualified descriptor. Include cases for bare-hash normalization,
mutable tags and refusal in configure/validate before credentials are touched.

No live resource creation/deployment or owner journal/fence changes are part
of this engineering proof. A new execution GO and fresh preflight remain gates.
