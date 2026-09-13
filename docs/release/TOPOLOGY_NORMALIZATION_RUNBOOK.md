# Topology normalization dispatch evidence

`controlled-topology-normalization.yml` is a one-shot Phase 0 controller. It
is manual-only and must not be dispatched until its exact inputs are frozen.

Immediately before dispatch, an operator with established production database
maintenance access must run the read-only SQLite command:

```sql
PRAGMA integrity_check;
```

The result must be exactly `ok`. Record the command context, timestamp, and
unmodified result in immutable operator evidence. Pass its reference as
`base_integrity_check_evidence`; the workflow records that reference in the
dispatch, but cannot derive database-file integrity from the BASE runtime's
`/readyz` endpoint. That endpoint only proves the migration ledger is readable.

Do not dispatch when the result is absent, differs from `ok`, or cannot be
attributed to the live BASE database. This evidence is a pre-dispatch gate; it
does not authorize merge, deployment, runtime-candidate publication, or Phase 1.
