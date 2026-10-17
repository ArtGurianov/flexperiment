# ART-337 · Python 3.10 compatibility repair

## Decision

The owner approved a narrow code repair after the reviewed dry-run failed on
VPS Python 3.10.12. Use SQLite's stable primary result codes, `SQLITE_BUSY = 5`
and `SQLITE_LOCKED = 6`, as module constants. Accessing optional Python module
attributes would retain the known incompatibility. Replacing the installed
interpreter would change host infrastructure and is outside this code GO.

Only the constant lookup changes in the controller. The online backup still
opens the source read-only, aborts immediately on BUSY/LOCKED, refuses when
the monotonic ten-second deadline is exceeded, checks integrity/foreign keys,
and removes its temporary snapshot. The Commerce write barrier, Payload
writer census, evidence custody, atomic journal publication and refusal on
ambiguous outcomes keep their existing contracts.

## Qualification

Reproduce the original failure using real Python 3.10.12, then run the complete
requalification and owner RPC contract suites on that interpreter. Add actual
WAL snapshot and BUSY contention cases, plus a real backup with a controlled
clock beyond the deadline. Preserve the real competing-writer regression.
Inject a LOCKED callback separately and require refusal before a deadline
check; distinguish this injected case from real SQLite contention. Add a real
Python 3.10 invocation to the existing exact-head `test` CI gate without
changing the other steps' interpreter or deployment workflows.
Owner RPC test fixtures isolate their owner/erasure roots from any real host
installation marker; marker-present guards remain explicitly tested.

## Execution boundary

This repair updates PR #222 only. Keep it unmerged and keep deployment source
`08523bdf38eeddf5e745ce04d05e1f980a7ced93` as current main. No live admission,
DB, container, timer, secret or provider operations belong to this code GO.
Independent review and a new execution GO must name the repaired controller
SHA. Execution must repeat fresh inventory, backups/read-backs, ledger/fence
checks and isolated recovery proofs; old freshness evidence cannot be reused.
