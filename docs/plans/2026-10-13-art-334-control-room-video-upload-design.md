# ART-334 · Control Room lesson video upload

2026-10-13. Commerce V2 owns the published course graph and the private
`video_upload_sessions` / `lesson_video_bindings` tables. The Control Room
session is the authorizing boundary for editors. Kinescope Tus receives file
bytes directly from the browser; the API token and provider video ID stay in
Commerce.

## Flow

1. The Control Room lists published Commerce editorial courses and their
   published lessons. Legacy manifest projections are not selectable for new
   uploads.
2. `POST /v1/admin/v2/video-uploads` requires the Control Room session,
   validates the selected lesson against the published Commerce graph, and
   reuses the existing Kinescope init and durable upload-session logic. It
   returns only the opaque session ID and the Tus endpoint.
3. The browser transfers bytes to the Tus endpoint. It polls the admin-auth
   status route until `READY` or `FAILED`. A lesson-scoped read returns the
   latest persisted state after reload without disclosing the provider ID.
4. A retry marks unfinished prior sessions `FAILED / SUPERSEDED` before the
   new session is inserted. Late provider success for a superseded session
   cannot replace the active binding. The previous READY binding remains until
   the current session reaches authoritatively verified `done`.

The existing webhook remains an independent Basic-authenticated status path.
Polling remains mandatory because webhook delivery is not guaranteed. A
provider outage returns a status error and never creates a successful binding.
All admin responses use `Cache-Control: no-store`.

## Qualification boundary

Local tests cover session authorization, editorial-lesson admission, opaque
responses, durable read-back and replacement failure. A real Control Room Tus
upload and Commerce binding read-back require a separate owner-approved canary
deployment and fixture write. Protected playback further requires an owner-
approved `KINESCOPE_DELIVERY_MODE=protected` replacement, a signed Commerce
grant, provider-origin callback and ART-36 license/revocation qualification.
The four-host canary 403 guard, payment and marketing settings are outside
this code change.
