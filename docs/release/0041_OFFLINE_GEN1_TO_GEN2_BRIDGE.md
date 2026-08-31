# HISTORICAL - DO NOT EXECUTE: 0041 offline Gen1-to-Gen2 bridge

The one permitted offline bridge is complete. It moved durable release control
from Gen1 `68f80a411b7f286928ef10826ed225228098d246` to Gen2
`0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34` while all Gen1 ledger readers were
excluded. The bridge maintenance artifact
`d899d0a2ee1e1b618fe10403ca83aacf7018db93` remains immutable forensic
evidence and is not a deployment target.

Gen1 is permanently retired as a ledger reader. This repository no longer
contains a bridge command, receipt reader/verifier, GitHub workflow, or host
runner for this event. Do not recreate any of them from this record.

The durable release ledger, the original receipt beside the production SQLite
database, and the immutable maintenance artifact are the audit record. They do
not authorize a replay, deployment, container start, or mutation.
