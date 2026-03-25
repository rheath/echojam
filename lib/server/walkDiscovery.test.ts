import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWalkDiscoverySuggestion } from "@/lib/server/walkDiscoverySuggestions";
import {
  buildAcceptedNearbyRouteStop,
  buildAcceptedNearbyStopSnapshot,
  resolveJourneyRouteStopImage,
} from "@/lib/server/walkDiscovery";

const TEST_ADMIN = {} as SupabaseClient;

test("resolveWalkDiscoverySuggestion picks a forward candidate and preserves candidate key", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
      locationRestriction?: { circle?: { radius?: number } };
    };
    const radius = requestBody.locationRestriction?.circle?.radius;

    const places =
      radius === 350
        ? [
            {
              id: "forward-place",
              displayName: { text: "Forward Library" },
              location: { latitude: 42.3607, longitude: -71.0506 },
              primaryType: "library",
              types: ["library"],
            },
            {
              id: "backward-place",
              displayName: { text: "Backward Library" },
              location: { latitude: 42.3591, longitude: -71.0506 },
              primaryType: "library",
              types: ["library"],
            },
          ]
        : [];

    return new Response(JSON.stringify({ places }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const candidate = await resolveWalkDiscoverySuggestion({
    admin: TEST_ADMIN,
    lat: 42.36,
    lng: -71.0505,
    recentPositions: [
      { lat: 42.3596, lng: -71.0505, timestamp: 1000 },
      { lat: 42.36, lng: -71.0505, timestamp: 2000 },
    ],
  });

  assert.equal(candidate?.id, "nearby-gplace-forward-place");
  assert.equal(candidate?.candidateKey, "place:forward-place");
});

test("resolveWalkDiscoverySuggestion falls back to the wider radius when needed", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;
  const radii: number[] = [];

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
      locationRestriction?: { circle?: { radius?: number } };
    };
    const radius = Number(requestBody.locationRestriction?.circle?.radius ?? 0);
    radii.push(radius);

    const places =
      radius === 700
        ? [
            {
              id: "fallback-place",
              displayName: { text: "Fallback Park" },
              location: { latitude: 42.3604, longitude: -71.044 },
              primaryType: "park",
              types: ["park"],
            },
          ]
        : [];

    return new Response(JSON.stringify({ places }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const candidate = await resolveWalkDiscoverySuggestion({
    admin: TEST_ADMIN,
    lat: 42.36,
    lng: -71.0505,
    excludedCandidateKeys: ["place:anything"],
  });

  assert.deepEqual(radii, [350, 700]);
  assert.equal(candidate?.id, "nearby-gplace-fallback-place");
});

test("resolveWalkDiscoverySuggestion excludes candidates already present in the route by google place id", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        places: [
          {
            id: "duplicate-place",
            displayName: { text: "Bunker Hill Monument" },
            location: { latitude: 42.37631, longitude: -71.06109 },
            primaryType: "tourist_attraction",
            types: ["tourist_attraction"],
          },
          {
            id: "backup-place",
            displayName: { text: "USS Constitution Museum" },
            location: { latitude: 42.3736, longitude: -71.0559 },
            primaryType: "museum",
            types: ["museum"],
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const candidate = await resolveWalkDiscoverySuggestion({
    admin: TEST_ADMIN,
    lat: 42.376,
    lng: -71.061,
    existingRouteStops: [
      {
        title: "Bunker Hill Monument",
        lat: 42.3763,
        lng: -71.0611,
        googlePlaceId: "duplicate-place",
      },
    ],
  });

  assert.equal(candidate?.candidateKey, "place:backup-place");
});

test("resolveWalkDiscoverySuggestion excludes candidates that match an existing route stop by title and nearby coordinates", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        places: [
          {
            id: "old-state-house-place",
            displayName: { text: "Old State House" },
            location: { latitude: 42.35878, longitude: -71.05783 },
            primaryType: "museum",
            types: ["museum", "tourist_attraction"],
          },
          {
            id: "backup-place",
            displayName: { text: "Boston Athenaeum" },
            location: { latitude: 42.35759, longitude: -71.06158 },
            primaryType: "library",
            types: ["library"],
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const candidate = await resolveWalkDiscoverySuggestion({
    admin: TEST_ADMIN,
    lat: 42.3588,
    lng: -71.0579,
    existingRouteStops: [
      {
        title: "The Old State House",
        lat: 42.35879,
        lng: -71.05782,
        googlePlaceId: null,
      },
    ],
  });

  assert.equal(candidate?.candidateKey, "place:backup-place");
});

test("buildAcceptedNearbyStopSnapshot preserves the accepted candidate title and coordinates", () => {
  const snapshot = buildAcceptedNearbyStopSnapshot(
    {
      id: "nearby-gplace-salem-common",
      title: "Salem Common",
      lat: 42.523018,
      lng: -70.8912,
      image: "/images/candidate.png",
      source: "google_places",
      distanceMeters: 4,
      googlePlaceId: "place-salem-common",
    },
    "/images/stale-canonical.png"
  );

  assert.equal(snapshot.title, "Salem Common");
  assert.equal(snapshot.lat, 42.523018);
  assert.equal(snapshot.lng, -70.8912);
  assert.equal(snapshot.imageUrl, "/images/stale-canonical.png");
  assert.equal(snapshot.googlePlaceId, "place-salem-common");
});

test("buildAcceptedNearbyRouteStop writes the accepted snapshot into the route stop", () => {
  const stop = buildAcceptedNearbyRouteStop({
    stopId: "nearby-canon-1",
    snapshot: {
      title: "Salem Common",
      lat: 42.523018,
      lng: -70.8912,
      imageUrl: "/images/candidate.png",
      googlePlaceId: "place-salem-common",
    },
    persona: "adult",
    selectedScript: "Fresh Salem Common story",
    selectedAudio: "https://example.com/salem-common.mp3",
    canonicalAssets: {
      scriptAdult: "Stale downtown story",
      scriptPreteen: null,
      scriptGhost: null,
      audioAdult: "https://example.com/stale.mp3",
      audioPreteen: null,
      audioGhost: null,
    },
    canonicalStopId: "canon-salem-common",
  });

  assert.equal(stop.title, "Salem Common");
  assert.equal(stop.lat, 42.523018);
  assert.equal(stop.lng, -70.8912);
  assert.equal(stop.imageUrl, "/images/candidate.png");
  assert.equal(stop.scriptAdult, "Fresh Salem Common story");
  assert.equal(stop.audioAdult, "https://example.com/salem-common.mp3");
  assert.equal(stop.canonicalStopId, "canon-salem-common");
});

test("resolveJourneyRouteStopImage falls back to google place photos for preset stops when canonical images are missing", () => {
  const imageUrl = resolveJourneyRouteStopImage({
    canonicalImage: null,
    curatedFallback: null,
    stopImage: "/images/salem/placeholder.png",
    googlePlaceId: "ChIJ123abc",
    canonicalSource: null,
  });

  assert.ok(imageUrl.includes("kind=place-id-photo"));
});

test("resolveJourneyRouteStopImage preserves a strong stop-specific image for custom route rewrites", () => {
  const imageUrl = resolveJourneyRouteStopImage({
    canonicalImage: "https://example.com/canonical.jpg",
    curatedFallback: null,
    stopImage: "https://example.com/stop-specific.jpg",
    googlePlaceId: "ChIJ123abc",
    canonicalSource: "places",
  });

  assert.equal(imageUrl, "https://example.com/stop-specific.jpg");
});
