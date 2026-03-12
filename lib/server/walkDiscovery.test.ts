import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWalkDiscoverySuggestion } from "@/lib/server/walkDiscoverySuggestions";

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
