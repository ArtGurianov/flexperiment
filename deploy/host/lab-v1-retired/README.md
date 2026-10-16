# Static LAB V1 retirement boundary

This service replaces only public V1 ingress with a static HTTP410 response.
It contains no Commerce, database, secrets, token validation, redirects or
financial operations. Support retains the previously published `art@` contact;
`refunds@` must not be published until delivery is independently confirmed.

The owner authorized retirement on16October2026 and confirmed every V1 buyer
and user is a test. This does not erase financial history or authorize another
charge/refund. Public V2/F9 remains closed. The serving V1 source is3ad07cf;
this host service is a separate infrastructure artifact, not a V1 application
deployment or a move of `production-deploy`.

## Admission and installation

1. Inventory exact Coolify application/worker identities, immutable images,
   active deploy queues, source/SQLite lineage, sales gate, financial states,
   refund obligations, emails, confirmation capabilities and tickets. A stale
   `payments.state` column or unfinished certification phase is not bank
   authority: use the actual serving consumers and payment/refund status facts.
2. Verify the fixed host binding matches the existing Coolify network:
   private bridge gateway10.0.1.1, backend18139. Refuse a different topology;
   do not substitute a public bind. Run the Python tests and verify the exact
   source/CI and file hashes before installing root-owned files.
3. Install `retired_server.py` at
   `/opt/flexperiment-lab-v1-retired/retired_server.py`, mode0644; install the
   service unit root-owned0644, daemon-reload and enable/start it. Prove local
   HTTP410 from the private bridge and the confined service's actual binding.
4. Atomically install the reviewed JSON-compatible YAML as
   `/data/coolify/proxy/dynamic/lab-v1-retired.yaml`. The file-provider routes
   have explicit legacy hosts, higher priority than old catchalls, and retain
   existing TLS. They exclude every canary V2 and Refref host. No proxy restart
   is needed. Confirm external HTTP/TLS410, no redirect/cookie and static body;
   new V1 checkout/capability issuance is now fenced by ingress.
5. Take a fresh encrypted archive with a consistent SQLite backup, original
   volumes/config/keys and exact source/image evidence. Require provider
   GET/hash and independent off-host isolated restore before shutdown. Preserve
   original-provider identities and a manual historical-case procedure. No
   blind retry or fake V2 request may replace reconciliation.
6. Disable auto-deploy/preview for the three V1 Coolify apps and any V1-only
   scheduled task. Stop through Coolify with `docker_cleanup=false`; wait for
   reported stopped state and absent running V1 HTTP/worker containers. Keep
   volumes, images, application records, credentials and archived data. Do not
   run a global Docker cleanup or reset database/erasure state.
7. After archive recovery, disable only the obsolete
   `flexperiment-recovery-backup.timer`, which requires a running V1 container.
   Preserve its historical archives and configuration. Keep V2/Refref/Coolify
   backup and freshness timers unchanged. No timer may delete the final
   retirement archive; no automatic expiry is introduced by this retirement.
8. Independently read back control-plane stop, absent legacy Docker routers,
   actual HTTP/TLS410 for representative methods/paths/query tokens, retained
   DB/volume, private listener, no token logging and unchanged unrelated
   container/source identities and guards. Record actual results separately
   from local tests/CI. Monitor the static service with systemd and HTTP probes.

## Manual historical cases and reactivation

An authorized operator uses the encrypted archive's original order/payment/
refund identifiers and supplier/provider receipt coordinates to locate a case
in the original bank/provider account. Check bank and ledger state before any
action; uncertain outcomes are reconciled under their original identity. The
archive preserves recovery keys and source for separately authorized isolated
inspection. It is not a permission to run V1 workers or connect a restored
database to production. Any new financial operation or reactivation needs fresh
explicit owner authority. Never migrate historical orders into V2 or fabricate
V2 customer/refund events.

When the admitted ledger contains no actionable financial queue and all buyers
are confirmed tests, no historical self-service path is retained. Unfinished
test certification records remain historical records. Preserve actual legal
retention/erasure decisions with archive custody; do not invent a deletion date.

The V2 email→Admin product flow is separate (PR246); retiring V1 does not install
that code or assert that the refunds mailbox works.

## Tests

`python3 -B -m unittest discover -s deploy/host/lab-v1-retired -p 'test_*.py'`

Tests cover arbitrary methods and legacy paths, query/body token non-disclosure,
no request logging, static410 headers, no redirects/cookies and explicit host
isolation. The same tests are a required step in the repository's Test workflow.
