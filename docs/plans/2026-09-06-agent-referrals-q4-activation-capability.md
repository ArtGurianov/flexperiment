# Agent Referrals Q4 activation-capability candidate

## Decision

Q3 cannot be activated directly.  Its runtime deliberately keeps
`activateAgentReferrals()` as an unwired CAS and has neither an internal
activation command nor an activation-readiness authority.  A controller-only
workflow would therefore depend on a Q4-only endpoint before Q4 was deployed.
Q4 is a detached, certified child of immutable Q3 and carries only the
activation capability below; deployment of Q4 remains strictly `DORMANT`.

This PR contains no workflow and performs no publication, promotion,
deployment, terminalization, activation, or ref mutation.

## Authority command

`POST /v1/internal/release-control/agent-referrals/activate` exists only in
the materialized Q4 runtime and remains behind the release-control bearer
middleware.  There is no public or admin-session counterpart.

The request has a deterministic activation owner
`agent-referrals-activation-<Q4-source>` and deterministic completed
predecessor `agent-referrals-q4-dormant-<Q4-source>`.  The command executes a
single `BEGIN IMMEDIATE` transaction that:

1. opens `BEGIN IMMEDIATE` and only then reads the exact DORMANT release
   predicate (schema, zero facts, exact
   runtime and worker revision, migrations, legal copies, surface contract,
   and legacy health);
2. proves the sales gate is open and unowned, Q4's DORMANT terminal release
   completed with the exact same expectation, and Q2 remains the exact
   `SURFACE_CONTRACT_UNAVAILABLE` superseded incident replaced by Q3;
3. pins or verifies one closed immutable activation-manifest object; and
4. applies the existing DORMANT-to-ACTIVE revision CAS and audit event.

Every failed assertion rolls back the manifest and feature-state writes.
Same-owner replay validates the same durable authority and leaves revision and
events unchanged.  A foreign owner, an invalid identity, or any stale
non-replay revision fails closed.

## Closed manifest

The only activation key is `agent-referrals-activation-v1`.  It contains the
protocol version, activation/terminal identities, target source, migration and
legal identifiers, the configured `unisender-go` OTP delivery identity, and a SHA-256 fingerprint of
`COMMERCE_AGENT_REFERRALS_OTP_PEPPER`.  The pepper is never stored or
returned.  The server derives all fields; callers cannot choose keys or
values.  Insert-only semantics make an exact replay safe and a changed value
a refusal.

This is intentionally not a generic configuration registry. Q4 wires the
production server through `otpSenderFromEnvironment()`: only an explicit
`COMMERCE_AGENT_REFERRALS_OTP_PROVIDER=unisender-go` plus valid transactional
provider configuration yields a configured sender. The command refuses the
default `UnconfiguredOtpSender`, so a pepper alone can never authorize ACTIVE.
The later activation workflow must still perform external reachability and
deployment/ref binding checks, because Git ref state and external hosts are
not facts the SQLite runtime can authoritatively read.

## Future boundaries

Only after this PR is independently reviewed and merged may a separate Q4
publication, promotion, DORMANT Q3-to-Q4 deployment, and Q4 terminalization
be considered.  That terminalization must stop for review.  A later manual
activation workflow must establish Git `production-deploy` and
`runtime-candidate` bindings before calling Q4's command; it must not use the
Q4 endpoint as a pre-Q4 deployment prerequisite.
