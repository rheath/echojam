import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveNearbyPlaces } from "@/lib/nearbyPlaceResolver";

const TEST_ADMIN = {} as SupabaseClient;
const FOLLOW_ALONG_INCLUDED_PRIMARY_TYPES = [
  "tourist_attraction",
  "museum",
  "art_gallery",
  "church",
  "library",
];

test("resolveNearbyPlaces honors explicit primary types and disables broad fallback", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;
  const requestBodies: Array<Record<string, unknown>> = [];

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async (input, init) => {
    const url = String(input);
    assert.match(url, /places:searchNearby/);
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        places: [
          {
            id: "strict-place-1",
            displayName: { text: "Museum of Stories" },
            location: { latitude: 42.3602, longitude: -71.0588 },
            primaryType: "museum",
            types: ["museum"],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const result = await resolveNearbyPlaces({
    admin: TEST_ADMIN,
    city: "boston",
    lat: 42.3601,
    lng: -71.0589,
    radiusMeters: 1_500,
    maxCandidates: 4,
    googleOnly: true,
    includedPrimaryTypes: FOLLOW_ALONG_INCLUDED_PRIMARY_TYPES,
    allowBroadGoogleFallback: false,
  });

  assert.equal(requestBodies.length, 1);
  assert.deepEqual(
    requestBodies[0]?.includedPrimaryTypes,
    FOLLOW_ALONG_INCLUDED_PRIMARY_TYPES
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.title, "Museum of Stories");
});

test("resolveNearbyPlaces preserves broad fallback behavior by default", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;
  const requestBodies: Array<Record<string, unknown>> = [];
  let callCount = 0;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    callCount += 1;

    if (callCount === 1) {
      return new Response(JSON.stringify({ places: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        places: [
          {
            id: "broad-place-1",
            displayName: { text: "Historic Library" },
            location: { latitude: 42.3602, longitude: -71.0588 },
            primaryType: "library",
            types: ["library"],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const result = await resolveNearbyPlaces({
    admin: TEST_ADMIN,
    city: "boston",
    lat: 42.3601,
    lng: -71.0589,
    radiusMeters: 1_500,
    maxCandidates: 4,
    googleOnly: true,
  });

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[0]?.includedPrimaryTypes, [
    "tourist_attraction",
    "museum",
    "art_gallery",
    "church",
    "library",
    "park",
  ]);
  assert.equal(requestBodies[1]?.includedPrimaryTypes, undefined);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.title, "Historic Library");
});
