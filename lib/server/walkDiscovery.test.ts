import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWalkDiscoverySuggestion } from "@/lib/server/walkDiscoverySuggestions";
import {
  buildAcceptedNearbyRouteStop,
  buildAcceptedNearbyStopSnapshot,
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
