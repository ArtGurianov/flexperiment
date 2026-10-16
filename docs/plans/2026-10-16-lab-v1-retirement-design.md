# Owner-authorized LAB V1 retirement

The owner confirms that all V1 users and purchases are tests and authorizes
technical shutdown without another GO. Preserve records and original-provider
recovery; do not create financial operations, migrate orders to V2, open F9 or
publish the unverified refunds mailbox.

## Observed boundary and chosen approach

Actual V1 source is 3ad07cf, served by three Coolify applications/four
containers: LAB frontend, Commerce HTTP + worker, and old Admin. The live ledger
contains three fully refunded test payments, three successful refunds/fulfilled
obligations, cancelled bookings, void tickets, delivered mail and applied
webhooks. Inspect active deployment ownership and every actionable queue before
admitting shutdown; an unfinished certification phase is not a pending payment.

Use a minimal static HTTP410 host service on the existing private Coolify bridge
and an explicit-host Traefik file-provider route. It executes no V1 code, reads
no ledger/secret, does not echo/log paths, queries, tokens or request bodies, and
does not redirect. Keep TLS at the existing proxy. The support text retains
art@flexperiment.ru until refunds@ delivery is proven. Explicit hosts exclude
all canary V2 and Refref hosts. This avoids replacing a shared proxy or
publishing another application image merely to return a tombstone.

Archive original data/config/evidence, a consistent SQLite snapshot, recovery
credentials, exact source/image identities and the manual-liability procedure.
Encrypt before provider custody, verify GET/hash and independently decrypt and
restore off-host without network/writers. No archive is a permission to restart
V1. Stop applications through Coolify with Docker cleanup disabled; preserve
volumes and immutable images. Disable V1 auto-deploy/scheduling and the obsolete
runtime-only backup timer after final archive custody, preserving V2/Refref and
infrastructure backup timers. No production-deploy pointer or live schema moves.

## Sequence and verification

1. Read-only inventory, current sales freeze, active-queue/financial admission.
2. Verify/build the static responder; activate explicit HTTP410 ingress to
   prevent new checkout and capability issuance while preserving other hosts.
3. Fresh encrypted archive and independent recovery; record any manual tails.
4. Coolify shutdown and V1-only scheduler retirement. Never delete live data.
5. Independently verify control-plane stop, absent running V1 containers and
   Docker-provider routes, external HTTP/TLS410/no-redirect/no-token execution,
   archive/DB lineage, unaffected V2/Refref images/readiness and backup timers.

Tests exercise arbitrary methods/paths/query tokens, static response headers,
absence of token logging and explicit route isolation. Actual host read-backs
are distinct from local tests/CI. Existing ART224 records execution; no new issue.
