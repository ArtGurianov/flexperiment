# ART334/338 — live upload and runtime widget contracts

## Evidence and scope

Owner accepted closed-canary availability risk under ART351, with ART337 Done.
Current applications remain immutable source085; no erasure/recovery changes.
Normal Chrome Control Room authored one synthetic UNLISTED/CLOSED course and
published v1. First actual file selection returned503 before any browser Tus
traffic. Read-only provider reconciliation found the new uploading video,
while Commerce persisted no upload session/binding. No automatic init retry.

A separate explicit synthetic init diagnostic returned201 with
`data.id`, regional HTTPS `ru-msk-uploader-2.kinescope.io`, UUID upload path and
one `id` query matching the video ID. The opaque endpoint remains root-private.
The older client rejected that host. This agrees with the provider's
[documented regional response](https://docs.kinescope.com/developer-guides/file-upload-via-api/).
Both empty synthetic provider objects remain recorded, not silently removed.

Platform `/account` separately rendered an undefined public widget key.
The image has no public-key build argument. A real matching site key and its
canary domain permission still need owner input; no CAPTCHA bypass is allowed.

## Choices

Keeping only the generic uploader host cannot handle this provider response.
Allowing all Kinescope subdomains needlessly broadens file destinations.
Use the generic host plus the bounded regional uploader naming family, with
HTTPS/default443, UUID `/v2/upload/` path, no userinfo/fragment, and only an
optional single video-matching `id` query. The API token stays at the fixed
init/read API endpoints; those calls reject redirects. Browser gets only the
validated opaque endpoint and existing session contract. No DB/DDL change.

Baking a separate site key into each image defeats promotion of one artifact.
Read explicit public `SMARTCAPTCHA_CLIENT_KEY` in the existing request-rendered
server subtree after awaiting searchParams. Keep the old NEXT_PUBLIC build
fallback for compatibility. Serialize only this public value, never the
server secret or environment object. Installed Next16.3.3 environment and
Request-time API guides were checked; no new client fetch/effect is needed.

## Verification and adoption

HTTP client regressions use documented/sanitized response shapes, positive
regional hosts and adversarial scheme/port/host/path/query/userinfo cases.
Rejections cannot persist sessions. Existing real-image CI smoke runs one
built Platform image with public key A then B, checks both actual account SSR
responses and image ID equality, and excludes a synthetic server-secret marker.

Independent review precedes merge. Adoption needs newly qualified immutable
Commerce/Platform artifacts and normal canary admission, never a live code
patch or response-rewriting workaround. Existing source085 runtime is retained
pending that gate. Current gateway work is separate PR225. Legal activation,
controlled mailbox, real CAPTCHA, provider callback/license and browser playback
remain separate live proofs. F9/production/payments/registration stay closed.
