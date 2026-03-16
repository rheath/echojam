# EchoJam Variable Cost Audit

Date: March 14, 2026

This worksheet estimates marginal variable cost for three concrete scenarios:

1. Cold-start 10-stop `Build Mix`
2. 10-post Instagram uploader collection publish
3. One full 10-stop listener session

The goal is not to predict the entire invoice. It is to estimate per-jam and per-listener unit economics using:

- repo-truth request counts from this codebase
- official vendor pricing pages
- explicit assumptions where the code does not expose a billable unit directly

## Important framing

- Fixed monthly fees are excluded.
- Google Maps and Supabase prices below are marginal overage prices. If usage stays inside included free or plan quotas, invoice impact can be `$0` even when the marginal worksheet shows a non-zero unit cost.
- Supabase does not charge per row write. Route/jam/stop writes matter operationally, but the billable parts are storage growth, disk growth, and egress.
- `Build Mix` and Instagram collection publish are not identical content pipelines:
  - `Build Mix` generates one script and one narration per stop.
  - Instagram import runs transcription + cleanup + conversion first, then only generates narration during publish.

## Official rate card

### OpenAI

Source: [OpenAI API pricing](https://platform.openai.com/docs/pricing/)

| SKU | Official price |
| --- | --- |
| `gpt-4o-mini` input | `$0.15 / 1M tokens` |
| `gpt-4o-mini` output | `$0.60 / 1M tokens` |
| `gpt-4o-mini-tts` | `$0.015 / minute` |
| `whisper-1` | `$0.006 / minute` |
| `tts-1` fallback | `$15.00 / 1M characters` |

### Google Maps Platform

Source: [Google Maps Platform core services pricing list](https://developers.google.com/maps/billing-and-pricing/pricing)

| SKU | Official price |
| --- | --- |
| Places API Text Search Pro | `$32.00 / 1,000 requests` |
| Places API Place Details Photos | `$7.00 / 1,000 requests` |
| Dynamic Maps | `$7.00 / 1,000 loads` |
| Routes: Compute Routes Essentials | `$5.00 / 1,000 requests` |
| Places API Place Details Essentials (IDs Only) | `Unlimited / no charge` |

Notes:

- The image proxy calls `Place Details` with `photos.name`, then fetches the actual photo media. The pricing docs classify `photos` under the IDs-only bucket and the media fetch under `Place Details Photos`.
- The listener worksheet treats the JavaScript `DirectionsService` usage as the nearest current Essentials route SKU at `$5 / 1,000`. That mapping is an inference from Google’s current pricing taxonomy plus the legacy Directions usage docs.

Supporting docs:

- [Place Details field-mask billing guidance](https://developers.google.com/maps/documentation/places/web-service/place-details)
- [Maps JavaScript API usage and billing](https://developers.google.com/maps/documentation/javascript/usage-and-billing)
- [Directions usage and billing](https://developers.google.com/maps/documentation/directions/usage-and-billing)

### Supabase

Sources:

- [Supabase Storage pricing](https://supabase.com/docs/guides/storage/pricing)
- [Supabase egress pricing](https://supabase.com/docs/guides/platform/manage-your-usage/egress)
- [Supabase billing overview](https://supabase.com/docs/guides/platform/billing-on-supabase)

| SKU | Official price |
| --- | --- |
| Storage size | `$0.021 / GB-month` over quota |
| Uncached egress | `$0.09 / GB` over quota |
| Cached egress | `$0.03 / GB` over quota |
| Database disk | `$0.125 / GB-month` over quota |

For these jam flows, storage and egress dominate. Database disk growth from a few rows of metadata is too small to matter at this scale, so it is called out qualitatively but not modeled as a meaningful line item.

## Repo-truth call counts

### 1) Cold-start 10-stop `Build Mix`

Relevant code paths:

- Place search: `app/api/stops/search-places/route.ts`
- Job creation: `app/api/mix-jobs/create/route.ts`
- Script + audio generation: `lib/customRouteGeneration.ts`
- OpenAI + storage helpers: `lib/mixGeneration.ts`
- Custom canonical stop behavior: `lib/canonicalStops.ts`

Observed behavior:

- The builder UI searches places through `places:searchText`.
- A cold-start custom route generation loop runs once per stop for script generation and once per stop for audio generation.
- `ensureCanonicalStopForCustom()` does not call Google image enrichment for normal custom routes. It stores the incoming stop image or placeholder only.
- Therefore, Google place-photo cost is excluded from custom jam creation.

Billable operations for a 10-stop cold start:

| Operation | Count |
| --- | --- |
| Google Places Text Search Pro | `10` |
| OpenAI `gpt-4o-mini` script generations | `10` |
| OpenAI `gpt-4o-mini-tts` narrations | `10` |
| Supabase audio uploads | `10` |
| Supabase route/jam/stop writes | many, but no per-request fee |

### 2) 10-post Instagram uploader collection publish

Relevant code paths:

- Draft creation: `app/api/instagram-imports/create/route.ts`
- Import worker: `lib/server/instagramImportWorker.ts`
- Publish collection: `lib/server/instagramImportWorker.ts`

Observed behavior:

- Import phase per post:
  - fetches public page metadata
  - downloads media locally
  - extracts audio locally
  - transcribes with `whisper-1`
  - runs two `gpt-4o-mini` chat completions: cleanup + tour-stop conversion
  - runs `1-3` Google Places Text Search calls depending on how quickly a candidate is found
- Publish phase for a 10-stop collection:
  - reuses the stored script text from drafts
  - generates one narration per stop
  - uploads one MP3 per stop
  - writes route, stop, canonical, and job state rows

Billable operations for a 10-post collection:

| Operation | Count |
| --- | --- |
| `whisper-1` transcriptions | `10` |
| OpenAI `gpt-4o-mini` chat completions | `20` |
| Google Places Text Search Pro | `10-30` |
| OpenAI `gpt-4o-mini-tts` narrations | `10` |
| Supabase audio uploads | `10` |
| Supabase route/jam/stop writes | many, but no per-request fee |

### 3) One full 10-stop listener session

Relevant code paths:

- Jam open / listen count: `app/api/jams/[jamId]/listen/route.ts`
- Route load: `app/HomeClient.tsx`
- Map load and route lookup: `app/components/RouteMap.tsx`
- Stop thumbnails: `app/HomeClient.tsx`
- Google image proxy: `app/api/google-image/route.ts`

Observed behavior:

- Opening a jam increments listen count once.
- Loading the route fetches app data, then initializes a Google map.
- The map component loads one dynamic map and one directions route for walking tours.
- The walk UI renders the full stop list with thumbnail images.
- For a custom `Build Mix` jam, those thumbnails are usually placeholders or stored assets, not live Google photo fetches.
- For an Instagram-published jam, the stored stop image can be a `/api/google-image?kind=place-id-photo...` URL, which can trigger one Google place-photo media fetch per unique stop image.
- A full listen-through streams all 10 MP3 files from Supabase storage.

Billable operations for one full session:

| Operation | Build Mix-style custom jam | Instagram-published jam |
| --- | --- | --- |
| Dynamic Maps load | `1` | `1` |
| Directions / route computation | `1` | `1` |
| Google place-photo media fetches | `0` primary | `5-10` |
| Supabase audio egress | `10 MP3s` | `10 MP3s` |

## Assumptions used in the math

### Build Mix assumptions

- `10` successful manual place searches
- Adult / AI Historian prompt path
- Script estimate per stop: `800` input tokens, `280` output tokens
- Spoken duration per stop: midpoint of the repo target `75-110s`, so `92.5s`
- MP3 size per stop: `1.0 MB` primary, `0.8-1.5 MB` sensitivity

### Instagram assumptions

- `10` imported posts published into one route
- Import transcription length per post: `45s` primary, `15-90s` sensitivity
- Cleanup + conversion combined chat usage per post: `1,500` input tokens, `400` output tokens primary
- Places fan-out: `2` Text Search Pro calls per post primary, `1-3` sensitivity
- Publish narration duration per stop: `60s` primary, `40-80s` sensitivity
- MP3 size per stop: `0.65 MB` primary, `0.45-0.9 MB` sensitivity

Note:

- The Instagram conversion prompt targets `90-180` words per stop in the current code, so its publish TTS cost is lower than the normal `Build Mix` adult/historian path.

## Primary worksheet

### Cold-start 10-stop `Build Mix`

| Cost bucket | Formula | Total |
| --- | --- | ---: |
| Google Places search | `10 * $0.032` | `$0.320` |
| OpenAI script generation | `10 * ((800 * $0.15/1M) + (280 * $0.60/1M))` | `$0.0029` |
| OpenAI narration | `10 * (92.5s / 60) * $0.015` | `$0.2313` |
| Supabase storage growth, monthly | `10 MB * $0.021 / GB-month` | `$0.0002` |
| Total marginal creation cost |  | **`$0.554`** |

Per-stop primary cost: **`$0.055`**

Sensitivity band:

- Low: **`$0.510`**
- High: **`$0.599`**

What actually moves the number:

- Google Text Search Pro is the single biggest fixed external cost in the builder path.
- TTS is the next largest cost.
- Script token cost is tiny by comparison.

### Instagram uploader: 10-post collection publish

#### Import phase

| Cost bucket | Formula | Total |
| --- | --- | ---: |
| Google Places search | `20 * $0.032` | `$0.640` |
| Whisper transcription | `10 * (45s / 60) * $0.006` | `$0.045` |
| OpenAI cleanup + conversion | `10 * ((1,500 * $0.15/1M) + (400 * $0.60/1M))` | `$0.0047` |
| Import subtotal |  | **`$0.690`** |

#### Publish phase

| Cost bucket | Formula | Total |
| --- | --- | ---: |
| OpenAI narration | `10 * (60s / 60) * $0.015` | `$0.150` |
| Supabase storage growth, monthly | `6.5 MB * $0.021 / GB-month` | `$0.0001` |
| Publish subtotal |  | **`$0.150`** |

#### Combined

| Metric | Total |
| --- | ---: |
| Full 10-post import + publish | **`$0.840`** |
| Per imported post | **`$0.084`** |
| Per published stop | **`$0.084`** |

Sensitivity band:

- Low: **`$0.438`**
- High: **`$1.257`**

What actually moves the number:

- The biggest driver is Google Places Text Search fan-out during import.
- TTS is the second-largest driver.
- The OpenAI text-model portion is still small.

## Listener worksheet

### One full 10-stop session: Build Mix-style custom jam

Primary assumptions:

- `1` Dynamic Maps load
- `1` directions request
- `10 MB` audio streamed across 10 MP3 files
- no Google place-photo fetches

| Cost bucket | Formula | Total |
| --- | --- | ---: |
| Dynamic Maps | `1 * $0.007` | `$0.0070` |
| Directions | `1 * $0.005` | `$0.0050` |
| Supabase audio egress, cached | `10 MB * $0.03 / GB` | `$0.0003` |
| Supabase audio egress, uncached | `10 MB * $0.09 / GB` | `$0.0009` |

Primary full-session total:

- Cached egress case: **`$0.0123`**
- Uncached egress case: **`$0.0129`**

Sensitivity band: **`$0.0122-$0.0133`**

### One full 10-stop session: Instagram-published jam

Primary assumptions:

- `1` Dynamic Maps load
- `1` directions request
- `10` unique stop thumbnails
- each thumbnail resolves to one Google place-photo media fetch
- `6.5 MB` audio streamed across 10 MP3 files

| Cost bucket | Formula | Total |
| --- | --- | ---: |
| Dynamic Maps | `1 * $0.007` | `$0.0070` |
| Directions | `1 * $0.005` | `$0.0050` |
| Google place-photo media | `10 * $0.007` | `$0.0700` |
| Supabase audio egress, cached | `6.5 MB * $0.03 / GB` | `$0.0002` |
| Supabase audio egress, uncached | `6.5 MB * $0.09 / GB` | `$0.0006` |

Primary full-session total:

- Cached egress case: **`$0.0822`**
- Uncached egress case: **`$0.0826`**

Sensitivity band: **`$0.0471-$0.0828`**

What actually moves the number:

- The image bill dominates this session, not the audio stream.
- The reason is the stop list renders all thumbnails, and the proxy resolves each `place-id-photo` image individually.

## Per-stop unit economics

| Scenario | Per-stop primary cost |
| --- | ---: |
| Build Mix creation | `$0.055 / created stop` |
| Instagram import + publish | `$0.084 / imported-and-published stop` |
| Build Mix listener session | `$0.0012-$0.0013 / listened stop` |
| Instagram listener session | `$0.0047-$0.0083 / listened stop` |

## Fallback / edge notes

- If narration falls back from `gpt-4o-mini-tts` to `tts-1`, cost stays in roughly the same ballpark:
  - Build Mix 10-stop narration: about **`$0.153-$0.216`** if you assume roughly `6` characters per word across `170-240` words per stop.
  - Instagram 10-stop publish narration: about **`$0.081-$0.162`** for `90-180` words per stop.
- If the project stays within Google Maps and Supabase included quotas, invoice impact for those portions can effectively be `$0`, while OpenAI remains directly usage-priced.
- If a listener opens a jam but does not play audio, the marginal cost is mostly the map load, route lookup, and any image fetches.

## Bottom line

Primary estimate, marginal overage basis:

| Scenario | Total |
| --- | ---: |
| Cold-start 10-stop Build Mix | **`$0.554`** |
| Instagram uploader 10-post collection publish | **`$0.840`** |
| One full listener session, Build Mix custom jam | **`$0.012-$0.013`** |
| One full listener session, Instagram-published jam | **`$0.082-$0.083`** |

The creation-side story is simple:

- `Build Mix` is mostly Google Text Search + TTS.
- Instagram collection publish is mostly Google Text Search during import + TTS during publish.

The consumption-side story is also simple:

- A normal custom jam is cheap to consume.
- An Instagram-published jam gets materially more expensive per listener because image fetches dominate the session cost.
