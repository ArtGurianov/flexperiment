# ART-36: isolate provider security qualification

The owner moved work to ART-36 after accepting ART-351 residual risks and marking
it Done. ART-351 is not reopened. Existing Chrome functional/provider evidence,
120s bearer transfer and roughly65s active revocation limits remain recorded;
no public launch, payment or automatic claim of production security is implied.

## Current evidence and choices

Read-only API inventory on16October shows the existing encrypted project has
strict=true and the exact Commerce Basic-authenticated DRM callback, but its
privacy_type is anywhere with no domains. All four active lesson bindings also
use anywhere. There is only one current project. Changing its callback for a
fault test would affect unrelated videos; replaying a fake HTTP client would
not prove the provider's own license decision.

The preferred prototype is a dedicated temporary encrypted project with one
copy of an owner-derived four-second test fixture, a strict callback restricted
to that copied video and its own random credentials, and a narrow separate
canary callback route. Existing project/video settings and Commerce are not
changed. An alternative documentary-only closure cannot demonstrate timeout
behavior. Changing the shared project is rejected for this investigation.

## Fixture boundary

A small standalone Node HTTP handler runs from the already qualified Commerce
image with its native app entrypoint unused. It has no Commerce data, customer
sessions, payment/mail/provider API credentials, Docker socket or host database
mount. Read-only code, an isolated config, bounded body/time/concurrency and
redacted events are required. One exact POST-only namespace on canary-api is
routed to it; all existing callback and four403 guards remain intact. It never
forwards or authorizes a live course.

Provider Basic Auth, exact copied video/type, and a separately HMAC-signed
single-fixture token are checked before a declared case can return200,403,401,
500, a response after7s, or close its socket. Cases are encoded in the signed
fixture token so no global mode race or per-case shared-project update exists.
Every case has a unique correlation reference; no token/body/viewer address,
User-Agent, credential or license bytes are logged.

An actual Chrome player on the allowed canary-platform HTTPS origin must first
obtain a license and advance playback. Fresh player instances then exercise
non200/timeout/unavailable cases, requiring actual license response, matched
provider-origin callback and no decoded playback. An independent canary-lab
origin and a no-referrer case probe domain behavior. These are explicit fixture
pages, not first-party buyer/consent/payment E2Es. No buyer login or paid grant is
fabricated.

## Stream and bearer limits

Read-only retrieval of an existing short fixture will inspect HLS/DASH DRM
markers, encrypted media bytes and responses with stripped CDN credentials.
Playable plaintext, per-segment Commerce authorization and immediate revocation
must not be inferred from an HTTP200 encrypted segment. The browser must see a
video identifier to embed it.

The provider callback exposes an opaque token, video, masked IPv4/24 and
User-Agent, but no authenticated first-party cookie or cryptographic browser
proof. IP/UA checks alone cannot honestly prove non-transferability. Record the
measured bearer limitation and concrete architectural choices instead of
silently relabelling it as browser binding or accepting a new production risk
on the owner's behalf. Safari/FairPlay remains conditional on launch scope.

## Admission and delivery

First prepare/test the exact fixture code and install manifest, immutable image
identity and read-only project/ingress snapshot. Before any externally visible
fixture activation, review its precise new project/copy/callback/route delta.
Never alter workspace DRM or move an existing video. An uncertain provider
mutation requires GET reconciliation before any retry. Retain redacted receipts
and remove only resources created by this execution after evidence preservation.

Re-read original project configuration and live runtime/fence/403 guards after
qualification. Publish a concise decision matrix separating prior actual proof,
new actual proof, documentary statements, accepted MVP limits and unresolved
production decisions. Update existing ART-36 only; create no new issues.
