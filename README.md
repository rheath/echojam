This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Dynamic Stop Images

Custom and preset routes can use canonical cached images for each stop.

Required env vars:

```bash
GOOGLE_PLACES_API_KEY=...
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...
NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=...
CANONICAL_IMAGE_SYNC_TOKEN=...
GOOGLE_PLACE_PHOTO_MAX_WIDTH=1400 # optional
```

Key roles:

- `GOOGLE_PLACES_API_KEY`: server-side key for Places, Geocoding, Place Photos, and route preview calls.
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`: browser key for the Google Maps JavaScript renderer. Restrict this key to your allowed web origins.
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`: browser map ID for the Google Maps JavaScript renderer and advanced markers.

Background sync endpoint (server-to-server only):

```bash
POST /api/canonical-stops/sync-images
Header: x-sync-token: $CANONICAL_IMAGE_SYNC_TOKEN
Body: {"limit":100,"maxAgeHours":168}
```

Recommended: run this on a schedule (hourly or daily) so user route loads do not call Google Places directly.

Pilot notes:

- Keep sync batches modest (for example `limit: 100`) and schedule runs conservatively.
- Ensure Google Places API and Place Photos usage is enabled with billing for your project.

## Preset Route Authoring

Preset routes are seeded from JSON and compiled into a generated runtime artifact.

Files:

- `app/content/presets/<city>.routes.json`: route metadata and ordered `stopPlaceIds`.
- `app/content/presets/<city>.meta.json`: city overview metadata and fallback image.
- `app/content/generated/presetRoutes.generated.ts`: generated output consumed at runtime.

Workflow:

```bash
# Build and emit generated routes + diagnostics
npm run presets:build

# CI/check mode (validates seeds and generation feasibility without writing files)
npm run presets:check
```

When adding a new city:

1. Add `<city>.meta.json`.
2. Add `<city>.routes.json` with `stopPlaceIds`.
3. Run `npm run presets:build`.
4. Optionally run `POST /api/canonical-stops/sync-images` scoped to that city to refresh Google-backed images.

## Paid Journey Launch

The paid preset flow uses:

- Supabase Auth magic links
- Stripe Checkout
- webhook-based entitlement creation

Launch checklist:

- [`docs/paid-journeys-launch.md`](/Users/robertheath/echojam/docs/paid-journeys-launch.md)

Production env template:

- [`.env.production`](/Users/robertheath/echojam/.env.production)
