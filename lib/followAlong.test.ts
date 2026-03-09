import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFollowAlongStops,
  buildRouteCandidates,
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
  normalizeDestinationQuery,
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
