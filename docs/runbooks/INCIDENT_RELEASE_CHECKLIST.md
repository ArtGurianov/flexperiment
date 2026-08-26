# Incident release checklist

- [ ] Read durable status first; do not infer from `HEAD` or `main`.
- [ ] Record owner/release ID, expected source, runtime and worker source,
  active legal version, and current legal-copy state.
- [ ] Decide whether this is generic recovery or legal-cutover recovery.
- [ ] For legal recovery, classify the exact durable state before action.
- [ ] Distinguish controller SHA from target, repair, and promotion SHA.
- [ ] Keep the target unchanged before a same-owner rerun.
- [ ] Do not use `git pull` to handle a pointer rejection.
- [ ] Do not use plain force and do not manually reopen sales.
- [ ] Move `production-deploy` only by exact CAS: observe, force-with-lease,
  re-read, prove target.
- [ ] After recovery, prove runtime, worker, frontend, and admin use the exact
  expected source.
- [ ] Close the incident only when durable completion is true.
