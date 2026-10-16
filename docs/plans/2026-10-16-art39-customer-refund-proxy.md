# ART-39 customer refund route

The paid buyer's normal `POST /v1/refunds` returned `NOT_FOUND` before reaching
Commerce. Platform's same-origin proxy omitted the existing customer refund
endpoint from its allowed paths. No refund request or bank refund was created.

Allow only `GET` and `POST` on the exact `/v1/refunds` collection through the
existing proxy. Keep authentication, ownership checks, origin validation,
idempotency, erasure admission and refund decisions in their existing layers.
Forward the buyer's session, request body and idempotency key unchanged. Refuse
refund subpaths and unsupported methods before sending an upstream request.

A new customer interface is unnecessary for this bounded run. A temporary
gateway bypass would introduce a second request path; fix the existing proxy
instead. Regression coverage checks session/body/key forwarding, upstream
authentication refusal, and exclusion of decision/execution paths. Existing
proxy tests retain foreign-host/origin, cookie and internal-route protections.

Install only the independently verified immutable Platform artifact after its
exact merged-source CI passes. Retain the Commerce source and image, financial
state, legal/fiscal evidence, credentials, Admin, external guards and backup
timers. Resume the same buyer refund request after installation. This repair
does not authorize another payment or public sales.
