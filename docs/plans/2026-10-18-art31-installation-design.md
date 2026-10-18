# ART-31 installation: closed canary, concrete proxy peers

The owner approved coordinated installation of merged PR #256, source
`e680cc11f1003424c570dbf30a8374bf5b6b57e7`. This is not a public launch or a
change to payment admission. The installed predecessor is `80a11bde`; the
Commerce delta is confined to login, with no schema migration.

Use a dedicated external Docker bridge `flexperiment-control-room-ingress`
containing only `coolify-proxy` and Admin nginx. Commerce retains only its
existing canary network, existing volumes, erasure authority, secrets and
payment profile. Connecting Traefik to the whole Commerce network would grant
unnecessary reach; restoring public routing would exceed this installation.

Keep the external closed-canary router in place. Qualify the real Traefik
entrypoint with a temporary, loopback-host-only, high-priority fixture route
using the real Admin service. Remove that route after proof. Compare TCP source
addresses with canonical headers using header-only packet observations; never
persist request bodies, password values or session cookies in public evidence.

Build the two native amd64 images from the exact approved source after its own
main CI succeeds. Publish/read back immutable private digests and native
identities. Preserve the Platform image, updating only its expected Commerce
source. Preserve an existing Control Room session across replacement.

Before changing running services, retain private root-owned copies of Compose,
env, release/artifact receipts, nginx inputs, proxy Compose and host helpers;
retain the old immutable images and an online SQLite backup. Rollback restores
configuration and images, not a stale database over subsequent writes. Stop
the old Commerce writer before admitting its replacement. No legacy V1 starts.

The backup helper must admit Admin's second network only with a root-owned
private receipt pinning network ID, container IDs and all relevant addresses;
Commerce/Platform remain confined. Drift or replacement invalidates that
receipt until requalified. Persist the proxy's network membership in its
Compose input without restarting Traefik or editing unrelated networks.

Acceptance covers real correct/incorrect password, forged CF/XFF/X-Real-IP/
Forwarded, distinct transport IPs, per-IP rejection, bounded account wait,
existing sessions, actual socket peers, unchanged volumes and closed ingress.
Read back native identities, readiness, schema integrity, erasure fence and
backup qualification. ART-31 remains open for TOTP, replay protection, CLI
reset and privileged service-token retirement.
