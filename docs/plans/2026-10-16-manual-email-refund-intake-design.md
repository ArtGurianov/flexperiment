# Shared email/manual Admin refund intake

The owner selected one customer flow for courses and LAB: write to
refunds@flexperiment.ru; an administrator registers the actual request,
decides it and separately executes a refund. The financial closed-course E2E
is already complete. This change prepares that product flow without another
payment, a production rollout or changes to historical LAB obligations.

## Design

Reuse V2's existing refund request, decision and execution authority. Add an
authenticated Admin registration endpoint and form. Resolve the customer from
the existing fulfilled order, verify the email sender against that customer,
and retain an evidence reference, receipt time and real session operator.
Registration produces REQUESTED only; it does not decide, execute, cancel
participation or revoke access. A database transaction covers the request,
intake metadata and audit record. Existing policy-facts JSON carries the
optional email-intake evidence, so no migration is required.

A stable registration key and immutable submitted body survive an ambiguous
response in the form. Exact replay returns the same request. Different evidence
under the same key or another open request for the order is refused. Existing
decision/execution/reconciliation code and provider lineage stay authoritative.

One shared static contact component appears in the courses account and LAB V2
account. It links to email and asks for the purchase email and order reference;
it exposes no financial refund command. The existing LAB V1 is inspected only:
its historical confirmation links and obligations remain valid. Accepted
review.4 stays immutable; the next legal release must align the refund contact
before this new customer flow is installed.

Direct customer self-service and automatic mailbox parsing were considered;
the explicit owner decision selects manual intake and a separate Admin decision.
Do not create customer sessions on behalf of email senders or a new refund rail.

## Validation and release

Verify authenticated/origin/fence boundaries, session-bound actor, customer/order
binding, evidence validation, replay/conflict behavior, transaction rollback and
the absence of decision/execution/access effects on registration. Exercise the
Admin form's lost-response replay and both customer contact surfaces. Run
Commerce/Admin/Platform/LAB type checks and relevant tests. Publication and
installation remain separate from this reviewable implementation; public F9
and historical LAB are unchanged.
