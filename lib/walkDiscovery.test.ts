import test from "node:test";
import assert from "node:assert/strict";
import {
  appendWalkDiscoveryPosition,
  buildWalkDiscoveryCandidateKey,
  createWalkDiscoverySuggestion,
  deriveWalkDiscoveryMovementVector,
  selectWalkDiscoveryCandidate,
  shouldExpireWalkDiscoverySuggestion,
  WALK_DISCOVERY_EXPIRE_DISTANCE_METERS,
} from "@/lib/walkDiscovery";
import type { NearbyPlaceCandidate } from "@/lib/nearbyPlaceResolver";

test("buildWalkDiscoveryCandidateKey prefers google place ids", () => {
  assert.equal(
    buildWalkDiscoveryCandidateKey({
      title: "Old North Church",
      lat: 42.3663,
      lng: -71.0544,
      googlePlaceId: "ChIJ123abc",
    }),
    "place:chij123abc"
  );
});

test("buildWalkDiscoveryCandidateKey falls back to stable coordinates and title", () => {
  assert.equal(
    buildWalkDiscoveryCandidateKey({
      title: "Boston Common",
      lat: 42.355,
      lng: -71.0656,
    }),
    "coord:42.35500:-71.06560:boston common"
  );
});

test("appendWalkDiscoveryPosition and vector derivation ignore tiny movement", () => {
  const samples = appendWalkDiscoveryPosition([], {
    lat: 42.36,
    lng: -71.05,
    timestamp: 1000,
  });
  const merged = appendWalkDiscoveryPosition(samples, {
    lat: 42.36001,
    lng: -71.05001,
    timestamp: 2000,
  });

  assert.equal(merged.length, 1);
  assert.equal(deriveWalkDiscoveryMovementVector(merged), null);
});

test("selectWalkDiscoveryCandidate filters excluded and backtracking places", () => {
  const candidates: NearbyPlaceCandidate[] = [
    {
      id: "ahead",
      title: "Ahead Museum",
      lat: 42.3607,
      lng: -71.0506,
      image: "/ahead.jpg",
      source: "google_places",
      distanceMeters: 120,
      googlePlaceId: "ahead-place",
    },
    {
      id: "behind",
      title: "Behind Monument",
      lat: 42.3591,
      lng: -71.0506,
      image: "/behind.jpg",
      source: "google_places",
      distanceMeters: 110,
      googlePlaceId: "behind-place",
    },
  ];

  const selected = selectWalkDiscoveryCandidate({
    candidates,
    currentPosition: { lat: 42.36, lng: -71.0505 },
    recentPositions: [
      { lat: 42.3596, lng: -71.0505, timestamp: 1000 },
      { lat: 42.36, lng: -71.0505, timestamp: 2000 },
    ],
    excludedCandidateKeys: ["place:behind-place"],
    radiusMeters: 350,
  });

  assert.equal(selected?.id, "ahead");
});

test("createWalkDiscoverySuggestion and expiry respect time and distance", () => {
  const suggestion = createWalkDiscoverySuggestion(
    {
      id: "museum",
      title: "Museum",
      lat: 42.3607,
      lng: -71.0506,
      image: "/museum.jpg",
      source: "google_places",
      distanceMeters: 120,
      googlePlaceId: "museum-place",
      candidateKey: "place:museum-place",
    },
    1_000
  );

  assert.equal(
    shouldExpireWalkDiscoverySuggestion({
      suggestion,
      currentPosition: { lat: 42.3608, lng: -71.0506 },
      now: 1_500,
    }),
    false
  );
  assert.equal(suggestion.isIncluded, false);
  assert.equal(suggestion.isFree, true);
  assert.equal(suggestion.priceLabel, "Free");
  assert.equal(suggestion.purchaseKey, "place:museum-place");
  assert.equal(
    shouldExpireWalkDiscoverySuggestion({
      suggestion,
      currentPosition: { lat: 42.3638, lng: -71.0506 },
      now: 1_500,
    }),
    true
  );
  assert.ok(suggestion.expiresAt > 1_000 + WALK_DISCOVERY_EXPIRE_DISTANCE_METERS);
});
