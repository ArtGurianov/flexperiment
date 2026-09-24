# Before launch

Everything in this repository describes the system as it is. This page is the
one exception, and it is short on purpose: a few facts about how the system got
here that a reader might otherwise reconstruct wrongly from silence.

Git holds the rest. `git log` is the archive; nothing below is a substitute for
reading it.

- The database carried data from the first day of development, and sixty-one
  migrations existed to protect it. None of that data was worth keeping: no real
  payment, no registered partner, no promo code that was not a test. The ledger
  collapsed into `0001_launch_baseline.sql`, which is deliberately
  lineage-incompatible with anything built from it - a pre-launch database is
  refused, never adapted.

- Agent Referrals shipped in stages behind an activation switch, with a
  `DORMANT` state meaning "before the feature existed". The staging is gone and
  so is that state: the feature is active from the moment a database exists.

- Email dispatch once had two authorities, a message-level one and an
  attempt-level one, with a column choosing between them. The attempt is the
  only one now.

- Releases were tracked through a machinery of generations, epochs and
  quarter-numbered phases, with a workflow per release. It is gone. The runtime
  knows its own commit, schema lineage, legal version and readiness; GitHub
  Actions owns candidates, promotion, deploy and rollback.

- Partners were called agents in the schema while every new column called them
  partners. The table is `partners`.

- An audited-resend model for the email outbox was designed in detail and
  never built. It assumed the two-authority world above, so the design does not
  describe this system; `git log` has it if the idea is wanted again.

- The provider integration was proved through a hand-run Phase 0 checkout
  procedure with a shape that no longer matches the product. The current
  procedure is [Production E2E certification](../commerce-production-e2e-certification.md).

- The launch itself crossed that lineage boundary with one-time machinery: a
  predecessor reader, a prepared-cutover envelope that the launch `deploy`
  adopted, a bootstrap archive and restore protocol with its own rollback
  commands, and a `LAUNCH_BASELINE` release class. It certified on 2026-09-24
  (session `e4cb1a91`, `3ad07cf`) and was deleted afterwards. Launch candidates
  and the launch session remain readable as records; none can be deployed or
  rolled back.
