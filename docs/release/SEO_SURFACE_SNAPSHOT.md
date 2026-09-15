# SEO surface snapshot

**Status: policy requirement. This document does not authorize or execute a
release, a production data change, or a deploy.**

`data/seo/occurrences.v1.json` is a committed, build-time projection of
Commerce's public tour. Static event and city pages are generated from it.
Commerce remains authoritative for every commercial fact in it; this file is a
copy, and the obligations below are what keep the copy honest.

The snapshot is deliberately **not** under `public/`. It must not be web-served:
it is a build input, not a published document.


## What the snapshot carries, and what it must never carry

Serialized, because each is a durable fact that changes only when an operator
deliberately changes it:

    id  event_slug  city  city_title  title  starts_at  ends_at  timezone
    price_kopecks  fulfillment_status  venue{status,name,address}

Excluded, permanently:

    availability  purchase_status  sales_status

`commerce/src/domain.ts` derives those three from `this.clock()`, a live
`COUNT(*)` over bookings, and the sales gate. They are correct for the instant
they were computed and for no other instant. Freezing them into static HTML
would publish a claim about seats and sales that is wrong by the time anyone
reads it, so they stay client-hydrated — `components/EventBooking.tsx` fetches
them on mount, exactly as `components/CheckoutFlow.tsx` already does.

The venue's `disclosure_text` and `announce_by` are also excluded. Those are the
wording Commerce composes for the checkout dialog; an event page states the
venue or says plainly that it is not announced, and never restates a promise
about when an email will be sent.


## The refresh obligation

**A change to any durable SEO fact requires an explicit snapshot regeneration, a
committed diff, and a frontend release.** That covers:

- a date or time change
- a city change
- a price change
- a venue being confirmed, changed, or withdrawn
- a cancellation
- a new occurrence being published
- an occurrence leaving `/v1/public/tour`

**Fast-moving runtime state does not.** Seat availability and sales state change
without any repository action, because they were never in the snapshot.

Until the regeneration ships, the static pages state what was true at the last
release. That is the cost of static generation and it is accepted knowingly —
but it means a date change that is not followed by a snapshot refresh leaves a
wrong date on a public page. Treat the refresh as part of the operator change,
not as follow-up work.


## Determinism

- Serialized with `canonicalV2` (`commerce/src/crypto.ts`, imported and never
  modified — it is in `compatibilitySemanticsPaths`, a category with no release
  lane), which sorts object keys recursively.
- One trailing newline, matching `write-static-release-descriptor.ts`.
- Sorted by `starts_at`, then `city`, then `id`.
- **No `generated_at`.** A timestamp would change the bytes on every run and
  destroy the one property worth having — regenerate from the same source, get
  the same file. Git records provenance more reliably.

`commerce/test/seo-snapshot-generation.test.ts` regenerates a simulated day
later and asserts byte identity.

### A departure must be recorded, never inferred

`PublicTourSource.departed` distinguishes three states for a previously
published id, and the generator requires the first two:

| | Meaning |
|---|---|
| present, a record | the occurrence still exists; its current state says how it left |
| present, `null` | `/v1/public/occurrences/{id}` answered **404** → `WITHDRAWN` |
| **absent** | nothing was looked up — **`SEO_SNAPSHOT_SOURCE_MALFORMED`** |

Treating an absent entry as a 404 would manufacture a `WITHDRAWN` tombstone — a
claim about production state — out of a gap in the input. The production
`--source` path always records an entry for every previously published id
missing from the tour, so this only ever fires on a malformed `--input`.


## Event URLs are permanent

`/events/<city-at-first-publication>-<full-uuid>`.

The city component is **frozen at first publication** and lives in the snapshot
itself. The generator reads the previously committed snapshot and preserves each
already-published `event_slug` rather than recomputing it. If an occurrence
moves city, the page content updates and the URL does not — recomputing it would
break every inbound link and indexed result.

The uuid is **full, never truncated**. A truncated id is a collision waiting for
a second occurrence.

`findTransitionDefects` refuses a regeneration that changes a published slug or
drops a published id without a tombstone.

### Tombstones

`tour()` filters to `fulfillment_status = 'SCHEDULED'` and `starts_at > now`, so
leaving that feed is ambiguous. `/v1/public/occurrences/{id}` applies no such
filter, and the generator uses it to disambiguate:

| `departed`  | Meaning |
|---|---|
| `CANCELLED` | the occurrence now reports `fulfillment_status: CANCELLED` |
| `COMPLETED` | it reports `COMPLETED` |
| `PAST`      | still `SCHEDULED`, but its start time has passed |
| `WITHDRAWN` | Commerce answered 404 — it is no longer exposed at all |

A tombstoned occurrence keeps its page and its URL. An event URL that has been
indexed, shared, and printed on a ticket must not start 404ing because a date
passed. It leaves the sitemap instead.

**A tombstone keeps whatever `fulfillment_status` Commerce last reported**, so
PAST and WITHDRAWN records still read `SCHEDULED`. Nothing may infer "archival"
from the status field. `PublishedRecord` (`SeoOccurrence | SeoTombstone`) and the
`isDeparted` guard carry the distinction through the whole rendering layer, and
widening that union back to `SeoOccurrence[]` silently reintroduces every one of
these failures:

| Surface | Rule |
|---|---|
| sitemap (`belongsInSitemap`) | live and `SCHEDULED` only — every tombstone excluded |
| home page city links, city "Ближайшие даты" (`isUpcoming`) | live and `SCHEDULED` only |
| city "Прошедшие и отменённые" | every tombstone, keeping its link |
| event page booking panel | mounted only for a live record |
| event page notice | `departureNotice(departed)` |
| Event JSON-LD (`mayEmitEventSchema`) | withheld for `WITHDRAWN`; kept for `CANCELLED`/`COMPLETED`/`PAST` |

`WITHDRAWN` is the one that withholds markup: `/v1/public/occurrences/{id}`
answered 404, so the snapshot holds the last data it ever saw with no way to
know whether any of it is still true. For the other three the re-fetch
succeeded and the record was re-projected from the live response, so its facts
are current.

The booking panel is the sharpest case. `EventBooking` is optimistically
bookable while its fetch is in flight and swallows failures — correct for a
scheduled date, since the checkout dialog does its own authoritative check — but
for a `WITHDRAWN` record that endpoint is *known* to 404, so the CTA would stay
up permanently. Departed records render a static notice and never hydrate.

A city whose dates are all archival keeps its page (its event pages link back to
it) but leaves the home page and the sitemap.


## Eligibility

`lib/seo/occurrence-publication.ts` is the single judge.

All JSON-LD is written through `serializeJsonLd` (`lib/seo/json-ld.ts`), which
escapes `<` as `\u003c`. `JSON.stringify` alone leaves `</script>` intact, and
inside a `<script>` element the HTML parser ends the element there regardless of
JSON context — so a Commerce-controlled title or venue name could close the
JSON-LD block and open a real one.

| Condition | Outcome |
|---|---|
| unknown city; timezone contradicts `lib/city-catalog.ts`; city title contradicts it; unparseable dates; `ends_at <= starts_at`; malformed id; slug belonging to another id; non-positive price; blank title | `INVALID` — no page, and **the generator fails** when the source is production |
| venue `TO_BE_ANNOUNCED`, or `CONFIRMED` with no name or address | `NOT_SCHEMA_ELIGIBLE` — page generated, **Event JSON-LD withheld** |
| everything else | `PUBLISHABLE` — page and Event JSON-LD |

`INVALID` fails rather than skipping because a contradiction in live inventory
is an operator problem to fix, not a record to drop quietly. A generator that
silently omitted it would hide the problem indefinitely.

`NOT_SCHEMA_ELIGIBLE` withholds markup because Google requires a real `location`
on an `Event`. A page that says «Площадка уточняется» in prose while asserting a
venue in machine-readable markup is worse than a page with no markup: one is
incomplete, the other is false.

### `eventStatus` comes from `fulfillment_status` only

| `fulfillment_status` | `eventStatus` | In sitemap |
|---|---|---|
| `SCHEDULED` | `EventScheduled` | yes |
| `CANCELLED` | `EventCancelled` | no |
| `COMPLETED` | `EventScheduled`, past date | no |

**Never** from `sales_status` or `purchase_status`. Sales and fulfillment are
orthogonal dimensions: a `SCHEDULED` event with sales `CLOSED` is a real,
correct, common state, and reading `NOT_YET_OPEN` or `SOLD_OUT` as "not
happening" would mark a live event cancelled in search results.

`COMPLETED` is decided explicitly rather than incidentally: schema.org has no
"this already happened" status. `EventScheduled` with a start date in the past is
the truthful reading — the event was scheduled, and it occurred.

### Known gap: no rescheduled state

`commerce/migrations/0001_initial.sql:27` constrains `fulfillment_status` to
`SCHEDULED | COMPLETED | CANCELLED`. There is no postponed or rescheduled state,
so a date change mutates `starts_at` in place and the previous start time is
retained nowhere the snapshot can see. **`EventRescheduled` with
`previousStartDate` can therefore never be emitted.** This is documented, not
worked around: inventing a previous date would be a fabricated fact.


## What CI does and does not check

CI validates the **committed** snapshot and proves fixture→snapshot determinism.

CI deliberately does **not** require Commerce to be reachable, and does **not**
fail because production occurrence state has moved on. Gating builds on live
drift would turn an unrelated frontend pull request red the moment an operator
edits a date, which trains everyone to ignore the signal.

Production-versus-snapshot drift is a separate manual or scheduled operational
check. It may open a snapshot-refresh pull request. It is never a
build-reproducibility gate.


## Zero eligible occurrences is a supported state

With an empty snapshot the build succeeds and emits no `out/events` and no
`out/cities` at all. The home page and the legal pages are unaffected.

Expressing that required one workaround, because Next 16 refuses an empty
`generateStaticParams()` under `output: "export"` — with no runtime there is
nothing to defer a path to, so a dynamic route in the tree must emit at least
one file even when the correct answer is none. Both routes fall back to a single
reserved `__placeholder__` param whose page renders the branded 404 body, and
`pnpm build` then deletes it via
`commerce/src/prune-seo-placeholder-routes.ts`. A URL answering 200 with a 404
body is still a fabricated event URL on a public site.

The prune is a narrow no-op when inventory exists.


## Regenerating

    # Production
    pnpm commerce:seo-snapshot:generate --source https://api.flexperiment.ru

    # From a recorded source reading (fixtures, CI)
    pnpm commerce:seo-snapshot:generate --input <file>

    # Verify without writing
    pnpm commerce:seo-snapshot:generate --source https://api.flexperiment.ru --check
    pnpm commerce:seo-snapshot:validate

HTTP is the only workable production source: the production SQLite file sits on
a Coolify volume reachable only from the api resource, so there is no
direct-read path from a controller checkout.

`next build` and the Docker build stay network-free. The snapshot reaches the
image through `Dockerfile.frontend`'s `COPY . .`, with `data/` absent from
`.dockerignore` — so no Dockerfile change is needed.
`commerce/test/seo-snapshot-ships.test.ts` asserts that seam, because nothing
else would fail if someone tightened `.dockerignore`.
