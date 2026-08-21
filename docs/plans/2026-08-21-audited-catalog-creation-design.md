# Audited catalog creation

## Goal

Provide the production-only Admin API commands needed to create a city and an
occurrence without using development seed data or direct database writes.

## Contract

- `POST /v1/admin/cities` accepts `name`, `slug`, and `reason`.
- `POST /v1/admin/occurrences` accepts the complete schedule, price, capacity,
  venue disclosure, and `reason`.
- Both commands require Admin authentication and `Idempotency-Key`.
- City slugs are unique. An occurrence validates that its city exists.
- An occurrence is always stored as `HIDDEN` and `CLOSED`; the request schema
  rejects attempts to supply those fields. Publication remains the existing
  audited `PATCH /v1/admin/occurrences/:id` command.

## Evidence and replay

The command transaction creates the entity, records the idempotency mapping,
and writes an `admin_audit_log` record containing actor, command action, entity
identifier, reason, idempotency-key hash, and canonical request hash. A matching
replay returns the original entity; the same key with a changed request fails
closed with `IDEMPOTENCY_CONFLICT`.
