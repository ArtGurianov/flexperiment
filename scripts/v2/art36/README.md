# Isolated ART36 provider fixture

This is an operator-only qualification fixture. It does not participate in
Commerce, issue course access, accept a payment, or configure the live project.
See [the design](../../../docs/plans/2026-10-16-art36-provider-qualification-design.md).

`provider-fixture.mjs` has no dependencies beyond Node built-ins. It refuses the
existing shared project ID, any non-fixture namespace, weak keys, wrong video,
wrong Basic Auth and invalid/expired fixture tokens. Only signed declared cases
can allow, deny, return401/500, wait7s or disconnect. The emitted reference,
intended status and observed connection state are diagnostics; they are not a
provider license result. Pair them with actual player/network evidence.

`fixture-manifest.py` renders exactly one disposable container and one POST-only
canary-api route. It pins the already qualified image by digest, explicitly runs
only this script, and mounts only read-only fixture code/config. There are no
application volumes, provider API/payment/mail credentials, published ports,
privileged capabilities or restart policy. The configuration file is separately
generated inside a root-private directory, readable only by the fixture UID.
Existing project/video IDs must never be moved or substituted into this fixture.

Before use, independently verify exact code CI/hash, immutable image/RootFS,
new project/video ownership, encrypted state, strict callback and intended
privacy domains. Preserve original live provider/ingress/runtime observations.
Unknown mutation results require GET reconciliation, not blind repeat. Remove
only the recorded fixture namespace/container/new resources after preserving
redacted evidence. Do not delete a project unless its recorded ID/ownership and
entire contents are proven to belong to this execution.

Local contracts: `node --test scripts/v2/art36/provider-fixture.test.mjs` and
`python3 -B -m unittest discover -s scripts/v2/art36 -p 'test_*.py' -v`.
They exercise a real loopback HTTP server and exact manifest boundaries. They
are not a real Kinescope license/CDM qualification or permission to alter the
shared project.
