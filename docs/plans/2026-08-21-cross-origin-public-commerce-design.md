# Cross-origin public Commerce API

The static site is served from `https://flexperiment.ru`; Commerce is served
from `https://api.flexperiment.ru`. Client components use one build-time public
base URL, `NEXT_PUBLIC_COMMERCE_API_URL`, for every `/v1/public/*` request.
The value is intentionally public and is frozen when the static app builds.

The Commerce API handles CORS only for `/v1/public/*`. It permits exactly the
configured public-site origin and the methods and headers required by checkout,
payment-status polling, and ticket capability retrieval. Unknown browser
origins fail with 403 and no CORS response header. Webhooks receive no CORS.

Admin remains intentionally outside this change: its host-only session cookie
cannot authenticate cross-origin requests to `api.flexperiment.ru`. Preserve an
admin same-origin proxy route unless that authentication model is explicitly
redesigned.
