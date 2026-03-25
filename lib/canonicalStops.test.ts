import test from "node:test";
import assert from "node:assert/strict";
import type { StopInput } from "@/lib/mixGeneration";
import {
  decideNearbyCanonicalReuse,
  type CanonicalStopRow,
} from "@/lib/canonicalStops";

function buildCanonical(overrides: Partial<CanonicalStopRow> = {}): CanonicalStopRow {
  return {
    id: "canon-1",
    city: "salem",
    title: "Existing Place",
    lat: 42.521,
    lng: -70.895,
    image_url: null,
    image_source: "placeholder",
    fallback_image_url: null,
    google_place_id: null,
    image_last_checked_at: null,
    ...overrides,
  };
}

function buildNearbyStop(
  overrides: Partial<StopInput & { googlePlaceId?: string | null }> = {}
): StopInput & { googlePlaceId?: string | null } {
  return {
    id: "nearby-stop",
    title: "Salem Common",
    lat: 42.522,
    lng: -70.892,
    image: "/images/candidate.png",
    googlePlaceId: undefined,
    ...overrides,
  };
}

test("decideNearbyCanonicalReuse reuses and refreshes a same-place-id canonical stop", () => {
  const decision = decideNearbyCanonicalReuse({
    stop: buildNearbyStop({
      title: "Salem Common",
      lat: 42.5231,
      lng: -70.8918,
      googlePlaceId: "place-salem-common",
    }),
    placeMatch: buildCanonical({
      title: "Old Downtown Label",
      lat: 42.5209,
      lng: -70.8941,
      google_place_id: "place-salem-common",
    }),
    nearest: null,
  });

  assert.equal(decision.kind, "reuse-place-id");
  assert.deepEqual(decision.updates, {
    title: "Salem Common",
    lat: 42.5231,
    lng: -70.8918,
    image_url: "/images/candidate.png",
    image_source: "link_seed",
  });
});

test("decideNearbyCanonicalReuse does not radius-merge a different google place id", () => {
  const decision = decideNearbyCanonicalReuse({
    stop: buildNearbyStop({
      googlePlaceId: "place-salem-common",
    }),
    placeMatch: null,
    nearest: buildCanonical({
      google_place_id: "place-downtown",
      title: "Downtown Salem",
    }),
  });

  assert.equal(decision.kind, "create-new");
  assert.deepEqual(decision.updates, {});
});

test("decideNearbyCanonicalReuse does not merge place-id-less stops with mismatched titles", () => {
  const decision = decideNearbyCanonicalReuse({
    stop: buildNearbyStop({
      title: "Salem Common",
      googlePlaceId: undefined,
    }),
    placeMatch: null,
    nearest: buildCanonical({
      title: "Salem Witch Museum",
      google_place_id: null,
    }),
  });

  assert.equal(decision.kind, "create-new");
  assert.deepEqual(decision.updates, {});
});

test("decideNearbyCanonicalReuse still reuses a place-id-less nearby stop when titles closely match", () => {
  const decision = decideNearbyCanonicalReuse({
    stop: buildNearbyStop({
      title: "Ropes Mansion Garden",
      image: "/images/ropes.png",
      googlePlaceId: undefined,
    }),
    placeMatch: null,
    nearest: buildCanonical({
      title: "Ropes Mansion & Garden",
      google_place_id: null,
      image_source: "placeholder",
    }),
  });

  assert.equal(decision.kind, "reuse-nearest");
  assert.deepEqual(decision.updates, {
    image_url: "/images/ropes.png",
    image_source: "link_seed",
  });
});
