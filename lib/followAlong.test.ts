import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFollowAlongStops,
  buildRouteCandidates,
  computeFollowAlongStoryCount,
  computeTriggerRadiusMeters,
  dedupeFollowAlongCandidates,
  normalizeRouteProgress,
  sampleRoutePoints,
  selectStoryCandidates,
  shouldTriggerFollowAlongStop,
  type FollowAlongLocation,
} from "@/lib/followAlong";
import {
  isValidFollowAlongLocation,
  fetchDrivingRoutePreview,
  normalizeDestinationQuery,
  reverseGeocodeFollowAlongOrigin,
} from "@/lib/followAlongApi";
import type { NearbyPlaceCandidate } from "@/lib/nearbyPlaceResolver";

const simpleRoute: [number, number][] = [
  [-71.1, 42.35],
  [-71.0, 42.35],
  [-70.9, 42.35],
];

test("normalizeDestinationQuery trims and compresses whitespace", () => {
  assert.equal(
    normalizeDestinationQuery("   Boston    Common   "),
    "Boston Common"
  );
});

test("isValidFollowAlongLocation accepts labeled coordinates", () => {
  const location: FollowAlongLocation = {
    label: "Boston",
    lat: 42.36,
    lng: -71.05,
    subtitle: "Boston, MA",
  };
  assert.equal(isValidFollowAlongLocation(location), true);
  assert.equal(isValidFollowAlongLocation({ label: "", lat: 0, lng: 0 }), false);
});

test("computeFollowAlongStoryCount uses 6 minute cadence with 2 story minimum", () => {
  assert.equal(computeFollowAlongStoryCount(60), 2);
  assert.equal(computeFollowAlongStoryCount(6 * 60), 2);
  assert.equal(computeFollowAlongStoryCount(12 * 60), 2);
  assert.equal(computeFollowAlongStoryCount(18 * 60), 3);
});

test("computeFollowAlongStoryCount caps at 9 stories", () => {
  assert.equal(computeFollowAlongStoryCount(54 * 60), 9);
  assert.equal(computeFollowAlongStoryCount(120 * 60), 9);
});

test("reverseGeocodeFollowAlongOrigin returns a formatted address", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("https://maps.googleapis.com/maps/api/geocode/json")) {
      return new Response(
        JSON.stringify({
          status: "OK",
          results: [{ formatted_address: "1 Main St, Boston, MA 02108, USA" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const origin = await reverseGeocodeFollowAlongOrigin({
    lat: 42.3601,
    lng: -71.0589,
  });

  assert.equal(origin.label, "1 Main St, Boston, MA 02108, USA");
  assert.equal(origin.subtitle, "Current location");
});

test("reverseGeocodeFollowAlongOrigin returns a generic origin when no provider resolves an address", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async () =>
    new Response("service unavailable", { status: 503 })) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const origin = await reverseGeocodeFollowAlongOrigin({
    lat: 42.3601,
    lng: -71.0589,
  });

  assert.equal(origin.label, "Current location");
  assert.equal(origin.subtitle, null);
});

test("reverseGeocodeFollowAlongOrigin falls back to OSM when Google geocoding is unavailable", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("https://maps.googleapis.com/maps/api/geocode/json")) {
      return new Response(
        JSON.stringify({
          status: "REQUEST_DENIED",
          error_message: "This API project is not authorized to use this API.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.startsWith("https://nominatim.openstreetmap.org/reverse")) {
      return new Response(
        JSON.stringify({
          address: {
            house_number: "24",
            road: "Beacon St",
            city: "Boston",
            state: "MA",
            postcode: "02108",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const origin = await reverseGeocodeFollowAlongOrigin({
    lat: 42.3601,
    lng: -71.0589,
  });

  assert.equal(origin.label, "24 Beacon St, Boston, MA 02108");
  assert.equal(origin.subtitle, "Current location");
});

test("sampleRoutePoints returns ordered samples along the route", () => {
  const samples = sampleRoutePoints(simpleRoute, 4_000, 2_000, 2_000);
  assert.ok(samples.length >= 3);
  assert.ok(samples[0].distanceAlongMeters >= 2_000);
  assert.ok(
    samples.every((sample, index) =>
      index === 0
        ? true
        : sample.distanceAlongMeters > samples[index - 1].distanceAlongMeters
    )
  );
});

test("dedupe and selection keep ordered story stops and append arrival", () => {
  const samples = sampleRoutePoints(simpleRoute, 5_000, 2_000, 1_000);
  const candidateGroups: NearbyPlaceCandidate[][] = [
    [
      {
        id: "place-a",
        title: "Story A",
        lat: 42.35,
        lng: -71.06,
        image: "/a.jpg",
        source: "google_places",
        distanceMeters: 80,
        googlePlaceId: "g-a",
      },
      {
        id: "place-a-duplicate",
        title: "Story A",
        lat: 42.35,
        lng: -71.0602,
        image: "/a2.jpg",
        source: "google_places",
        distanceMeters: 140,
        googlePlaceId: "g-a",
      },
    ],
    [
      {
        id: "place-b",
        title: "Story B",
        lat: 42.35,
        lng: -70.97,
        image: "/b.jpg",
        source: "google_places",
        distanceMeters: 65,
        googlePlaceId: "g-b",
      },
    ],
  ];

  const candidates = buildRouteCandidates(simpleRoute, samples, candidateGroups);
  const deduped = dedupeFollowAlongCandidates(candidates);
  assert.equal(deduped.length, 2);

  const selected = selectStoryCandidates(deduped, 2, 1_000);
  assert.equal(selected.length, 2);
  assert.ok(selected[0].distanceAlongRouteMeters < selected[1].distanceAlongRouteMeters);

  const destination: FollowAlongLocation = {
    label: "Boston Common",
    lat: 42.355,
    lng: -71.065,
    subtitle: "Boston, MA",
    placeId: "dest-1",
  };
  const stops = buildFollowAlongStops(selected, destination, 18_000, 500);
  assert.equal(stops[stops.length - 1]?.stopKind, "arrival");
  assert.equal(stops[stops.length - 1]?.title, "Boston Common");
});

test("trigger logic only fires when the next stop is close enough on-route", () => {
  const stop = {
    distanceAlongRouteMeters: 9_800,
    triggerRadiusMeters: computeTriggerRadiusMeters(14),
  };
  const nearTrigger = shouldTriggerFollowAlongStop({
    routeCoords: simpleRoute,
    myPos: { lat: 42.35, lng: -70.982 },
    stop,
    speedMps: 14,
  });
  assert.equal(nearTrigger.shouldTrigger, true);

  const tooFar = shouldTriggerFollowAlongStop({
    routeCoords: simpleRoute,
    myPos: { lat: 42.35, lng: -71.09 },
    stop,
    speedMps: 14,
  });
  assert.equal(tooFar.shouldTrigger, false);
});

test("normalizeRouteProgress exposes off-route distance", () => {
  const onRoute = normalizeRouteProgress({ lat: 42.35, lng: -71.01 }, simpleRoute);
  const offRoute = normalizeRouteProgress({ lat: 42.37, lng: -71.01 }, simpleRoute);
  assert.ok(onRoute.distanceToRouteMeters < 50);
  assert.ok(offRoute.distanceToRouteMeters > 1_000);
});

test("fetchDrivingRoutePreview fills origin subtitle from start_address when missing", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("https://maps.googleapis.com/maps/api/directions/json")) {
      return new Response(
        JSON.stringify({
          status: "OK",
          routes: [
            {
              overview_polyline: { points: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
              legs: [
                {
                  distance: { value: 1600 },
                  duration: { value: 420 },
                  start_address: "10 Beacon St, Boston, MA 02108, USA",
                  end_address: "1 Charles St, Boston, MA 02114, USA",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const preview = await fetchDrivingRoutePreview(
    {
      label: "Current location",
      subtitle: null,
      lat: 42.3601,
      lng: -71.0589,
    },
    {
      label: "Boston Common",
      subtitle: null,
      lat: 42.355,
      lng: -71.065,
    }
  );

  assert.equal(preview.origin.label, "10 Beacon St, Boston, MA 02108, USA");
  assert.equal(preview.origin.subtitle, "Current location");
  assert.equal(preview.destination.subtitle, "1 Charles St, Boston, MA 02114, USA");
});
