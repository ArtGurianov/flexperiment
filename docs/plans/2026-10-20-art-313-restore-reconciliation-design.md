# ART-313: isolated merchant recovery

Implement a one-shot owner tool on an independently retrieved SQLite restore. Keep the runtime,
jobs, email and new money stopped. Close every local sale gate durably, replay the independently
current erasure ledger, and reconcile immutable merchant order IDs and canonical snapshot hashes.

Ordinary pending-checkout reconciliation is unsuitable: it can create a payment session, ignores
already-paid orders and cannot discover refunds lost with the merchant backup. Importing Refref as
a replacement merchant database would invent legal consent and manual/editorial authority. Instead,
require an independently reviewed complete order/refund inventory, read Refref through GET-only
merchant-order, fulfillment and accepted-refund endpoints twice, and commit repairs atomically only
when both observations and the isolated database agree.

Recover accepted full payments and full refunds idempotently, including missing purchase grants and
revocations. Preserve local manual grants, consents, editorial history and used LAB tickets. Record
accepted facts in the existing audit store without inventing refund approvals or legal acceptance.
Unknown schemas, multiple attempts, partial refunds, incomplete inventories, deleted financial
subjects and contradictory bindings hold recovery closed. Entirely lost merchant orders need their
independent merchant-side records recovered first: Refref does not own their identity/consent proof.

Use the existing fresh Cloud.ru erasure reader and verification keys; do not accept cached JSON as
erasure authority. No migration, service endpoint, runtime startup, external money mutation, automatic
GO or sales activation. Report hashes bind the reviewed inventory, stable remote observations and
deterministic local read-back. Owner GO is recorded separately after independent read-back and the
documented negative drills, and never substitutes for deployment/erasure admission.

Validate with real SQLite online backup/restore fixtures, post-backup accepted payment/refund tails,
replays, denied access, preserved merchant facts, fresh erasure suppression and adversarial mismatches.
