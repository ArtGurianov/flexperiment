# SEO production findings and operator actions

**Status: operator report. This document does not authorize or execute a
release, a production data change, a migration, or a deploy. Nothing in it has
been carried out.**

Everything below was observed by read-only `GET` against public endpoints and
by inspecting the built static export. No production data was mutated, no
deploy or ref promotion occurred, and no Coolify change was made.


## 1. Production inventory is a fixture, and the snapshot rejects it

`GET https://api.flexperiment.ru/v1/public/tour` returns exactly one occurrence:

| Field | Value |
|---|---|
| `id` | `727b3860-598c-43a3-8739-fd70d2e9deae` |
| `city` / `city_title` | `saint-petersburg` / Санкт-Петербург |
| `title` | `Питер` |
| `timezone` | **`Asia/Novosibirsk`** |
| `starts_at` | `2026-09-25T10:02:00.000Z` |
| `ends_at` | `2026-09-26T10:03:00.000Z` |
| `price_kopecks` | `360000` (3 600 ₽) |
| `sales_status` | `CLOSED` |
| `purchase_status` | `NOT_YET_OPEN` |
| `fulfillment_status` | `SCHEDULED` |
| `venue.status` | `TO_BE_ANNOUNCED` |
| `venue.disclosure_text` | `Выбираем место` |
| `venue.announce_by` | `2026-08-27T10:03:00.000Z` |

Every Siberian city returns `{"occurrences":[]}`.

**The snapshot generator rejects this record and exits non-zero:**

    $ pnpm commerce:seo-snapshot:generate --source https://api.flexperiment.ru
    SEO_SNAPSHOT_OCCURRENCE_INVALID 727b3860-598c-43a3-8739-fd70d2e9deae TIMEZONE_CONTRADICTS_CATALOGUE
    SEO_SNAPSHOT_OCCURRENCE_INVALID

`lib/city-catalog.ts` gives `saint-petersburg` the zone `Europe/Moscow`, and
`lib/city-catalog.test.ts` asserts every catalogue zone against
`Intl.supportedValuesOf("timeZone")` — so the catalogue is a real oracle and
this record contradicts it. A page generated from it would show a time five
hours wrong for an event people plan travel around.

`data/seo/occurrences.v1.json` is therefore committed **empty**, and the build
emits zero event and zero city pages. This is the intended fail-closed
behaviour, not an incomplete implementation.

### Other problems in the same record, for whoever corrects it

None of these is what the generator rejected on, but each is worth deciding
about before the record is published:

- **`announce_by` is already in the past** (2026-08-27) while the event is in
  the future (2026-09-25). The venue disclosure promises an email that, by the
  record's own deadline, should already have been sent.
- **`title` is `Питер`**, an informal nickname. It would appear in the event
  page's `<h1>`, `<title>`, the Event JSON-LD `name`, and every social card.
- **`ends_at` is the next day** — a 24-hour-and-one-minute workshop. Valid
  (`ends_at > starts_at`), so nothing rejects it, but it is almost certainly a
  data-entry artifact and it would be emitted as `endDate` in the markup.
- **`10:02` / `10:03`** look like the minutes a test record happened to be
  created at.
- **Venue `TO_BE_ANNOUNCED`** is legitimate. Note only that it means Event
  JSON-LD stays withheld even after the timezone is fixed — the page publishes,
  the structured data does not, until a venue is confirmed.
- **Price 360000 kopecks = 3 600 ₽**, which matches neither editorial figure on
  the home page (3 800 ₽, or 3 500 ₽ with a promo code). That is allowed — the
  home page price is editorial and the occurrence price is authoritative, and
  there is deliberately no fallback between them — but it is worth confirming
  it is intended rather than stale.

### The supported correction path

The timezone is derived on create from `lib/city-catalog.ts` (see that file's
note about C2), so an occurrence whose zone disagrees with its city was either
created before that derivation existed or had its city changed afterwards.

Correct it **through the admin surface that owns occurrences**, so the change
goes through the same validation, audit and notification path as any other
operator edit. Changing `starts_at`, `ends_at`, `title` or the venue is a
material change and Commerce will treat it as one — including the
`occurrence-updated` notification and the organizer-change refund entitlement.

**Do not write a migration to delete or rewrite this record.** A migration
would bypass the material-change machinery, and no migration is being proposed
here.


## 2. Cutover sequence

Listed for the operator. **None of it has been executed.**

1. Correct the occurrence in Commerce (timezone via its city; and decide on
   `title`, `ends_at`, `announce_by`, price).
2. Verify: `curl -s https://api.flexperiment.ru/v1/public/tour | jq`.
3. Regenerate: `pnpm commerce:seo-snapshot:generate --source https://api.flexperiment.ru`.
4. Validate: `pnpm commerce:seo-snapshot:validate`.
5. Review the committed diff to `data/seo/occurrences.v1.json`. Every line of it
   is a public commercial claim.
6. Commit, open a pull request, let CI run.
7. Build: `SOURCE_COMMIT=$(git rev-parse HEAD) pnpm build`.
8. Inspect `out/events/*.html` and `out/cities/*.html` by hand — the date in the
   occurrence's own zone, the venue wording, the price, and whether Event
   JSON-LD is present or correctly withheld.
9. Release through the normal controlled release process for this repository.
   This change set is in the **generic** deploy lane
   (`genericProductionDeployBoundary` returns undefined for every path it
   touches).
10. Verify over production HTTP: `robots.txt`, `sitemap.xml`, one event page,
    one city page, an unknown URL returning the branded 404.
11. Submit the sitemap to Yandex Webmaster and Google Search Console.


## 3. Redirects are 302 and this repository does not own them

Measured:

    http://flexperiment.ru   -> 302 -> https://flexperiment.ru
    https://www.flexperiment.ru -> 302 -> https://flexperiment.ru

Both should be **301**. A 302 tells a crawler the canonical location may change
back, so link equity consolidates onto the apex more slowly and less
completely.

`deploy/frontend.nginx.conf` does not perform either redirect, and it runs with
`absolute_redirect off` precisely because it sits behind Traefik/Coolify and
does not reliably know the public scheme or host. **The redirects are therefore
owned by the reverse proxy layer, not by this repository**, and the change is an
operator change in Coolify/Traefik: make both permanent.

No configuration has been added here to "fix" this. Adding a redirect to the
nginx config would be dead config that never executes in production while
looking, in review, like the problem was solved.

### `deploy/Caddyfile` is stale

Its apex block routes `/v1/*` to the commerce service, but
`https://flexperiment.ru/v1/public/tour` returns **404** in production — the API
actually lives at `api.flexperiment.ru`. The file describes a topology that is
not deployed.

It is left unchanged here on purpose: `deploy/test-caddyfile-topology.sh`
asserts its admin/partner routing, it is explicitly a *reference* topology, and
correcting the apex block is a deployment-topology decision rather than an SEO
one. Flagged so it is not mistaken for a description of production.


## 4. Search Console / Webmaster verification

**The site is not claimed here to be unverified.** No HTML meta verification
token exists in the repository, but DNS-based verification is invisible from a
repository and may well already be in place. Check the property in each console
before adding anything.

If a token is ever needed, `app/layout.tsx` can carry
`verification: { google, yandex }` from build-time values. No placeholder is
hardcoded, because a wrong verification token is worse than none.

**Prefer DNS verification**: one TXT record covers the apex, `www`, and every
subdomain, including `admin.` and `partner.`, and it survives a frontend
redeploy.


## 5. Things deliberately not done

- No `FAQPage` structured data. Google restricted FAQ rich results to
  government and health sites in August 2023, so the markup buys nothing. The
  four-question FAQ stays because it is useful content.
- No `Offer` in any structured data. An Offer asserts purchasable seats at a
  price, and the only price a static page could assert is either editorial (the
  home page's) or a frozen copy of a live one. Neither is a safe thing to
  promise a search engine.
- No `sameAs`, `address`, `logo`, `award` or `foundingDate` on the
  Organization. The repository carries no verified values, and a
  plausible-looking guess in structured data is a claim rather than a
  placeholder.
- No removal or 404ing of `.txt` or `.md` responses. The `.txt` payloads are
  the App Router's client-side navigation, and
  `commerce/src/legal-release.ts:63` fetches the `.md` files over HTTPS to
  verify their sha256 against `commerce/legal/production-manifest.json`. Both
  are crawl-suppressed by header only.
- No `Disallow` in `robots.txt` for those surfaces. `Disallow` and
  `X-Robots-Tag` cannot be combined — a crawler that obeys the first never
  fetches the URL and so never sees the second — and a `Disallow`ed URL can
  still be indexed URL-only. Crawl budget is not a constraint at this size.
