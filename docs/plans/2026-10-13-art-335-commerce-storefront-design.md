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
The platform image starts Next directly, has no editorial SQLite mount or
backup helper, and refuses the old Payload environment variables in closed
canary mode. The Commerce server stops calling the platform revalidation
route because every closed-canary content read is request-time and no-store.
The old platform snapshot and scheduled-backup source files remain for the
currently installed archive and are retired operationally only at the
separately authorized ART-337 cutover; this source change does not delete
archived ciphertext or alter the installed scheduler.
ART-337 must first preserve and independently read back the exact archived
Payload snapshot, disable and read back the old platform backup timer, remove
the old editorial and backup volume mounts and Payload variables from the
canary application, then install the reviewed image. The new canary admission
refuses those variables, and its CI image proof asserts zero mounts and 404
for the old admin/API routes. Commerce backup, erasure ledger and runtime
fence retain their own independent qualification gates.
Focused tests exercise public-field allowlists, current visibility and
withdrawal, private session/consent denial, Commerce outage, content-version
consistency, and the absence of video IDs in public output. CI must build and
boot the Payload-free platform image. Runtime installation, canary DB changes,
retiring archived ciphertext and public opening stay in ART-337/339 gates.

## Commerce readiness before production admission

The platform must reject Commerce `foundationMode` in every environment, not
only in canary. A foundation runtime can answer its own `/readyz` with HTTP 200
while all course APIs remain closed, so platform readiness cannot treat its
database check as sufficient. Requiring `foundationMode: false` only when
`DEPLOY_ENV=production` leaves a staging admission gap. Changing Commerce's
foundation readiness would affect other consumers. The narrow platform check
requires the explicit false value everywhere and preserves the canary-only
exact SHA, disabled payments and Refref checks. A non-canary HTTP regression
asserts both `true` and an omitted field return 503, while `false` returns 200.
