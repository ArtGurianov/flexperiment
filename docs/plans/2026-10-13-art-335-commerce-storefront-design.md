# ART-335 · Payload-free Commerce storefront

## Decision

Use Commerce V2's committed projection graph as the only source of course,
section and lesson content. Keep `apps/platform` as a request-time Next SSR
renderer and cookie-aware proxy. The closed canary has no course-content ISR,
publication callback, or static search/sitemap snapshot. A failed Commerce read
fails closed and never falls back to Payload or a stale in-process copy.

Three approaches were considered. Keeping Payload as a read replica preserves
existing pages but retains the second editorial database and manifest lease.
Copying the projection into a new platform cache restores the same dual-state
failure mode. A narrow Commerce read API with uncached platform fetches has a
larger source change but makes committed publication and page rendering share
one authority; it is the chosen path.

## Contract

Commerce serves public listed course summaries, a listed course's public
outline, and a listed lesson's public metadata. It joins withdrawn product and
lesson state before returning content, projects only allowlisted fields, and
does not return draft, Kinescope video ID, signing material or credentials.
The private library and course/lesson endpoints use the existing Commerce
session, current consent and `listCustomerLibrary` decision to enrich only
allowed course and lesson refs with titles, URLs and private lesson text.
An entitled customer retains private SSR access to published `UNLISTED`
course, section and lesson content, as the playback policy already allows;
withdrawal and revocation still deny immediately. The platform tries private
content first for a signed-in request, then the public listed read. No
platform-side entitlement decision is authoritative. Public metadata never
calls the private endpoint.

The platform fetches these APIs with `cache: "no-store"` and bounded timeouts.
Request-time course pages and their metadata render from the same committed
version; private library responses and browser search are no-store. The
Commerce playback route remains the only grant authority. Unlisted content
never produces a public lesson page or stale public search entry; withdrawn,
unpublished, missing and unavailable content never produces a working lesson
page. Closed-canary robots stay
disallow-all. IndexNow, ISR and durable publication effects belong to ART-339.

## Source transition and proof

The first source PR introduces the Commerce read boundary and moves catalogue,
course, lesson, private library, browser search and their tests to it. It keeps
the current Payload runtime, admin route and backup machinery untouched so the
active canary remains on its existing release. This stage is not ART-335
completion and must not be deployed alone. A following reviewed source step
removes the remaining Payload runtime and adapts image/CI contracts; ART-337
owns the separately authorized installation and archival transition.

The source cut removes Payload routes, config, collections, migrations,
manifest workers, direct SQLite mount assumptions and Payload packages from
the platform image after all callers move to Commerce. Build identity,
Commerce readiness, account cookies, and the four-host 403 guard remain.
Focused tests exercise public-field allowlists, current visibility and
withdrawal, private session/consent denial, Commerce outage, content-version
consistency, and the absence of video IDs in public output. CI must build and
boot the Payload-free platform image. Runtime installation, canary DB changes,
retiring archived ciphertext and public opening stay in ART-337/339 gates.
