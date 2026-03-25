import test from "node:test";
import assert from "node:assert/strict";
import { buildWalkDiscoveryCandidateKey } from "@/lib/walkDiscovery";
import { mapResolvedRouteStops } from "@/lib/resolvedRouteStops";

test("mapResolvedRouteStops preserves preset google place ids for walk discovery exclusion keys", () => {
  const [mappedStop] = mapResolvedRouteStops([
    {
      stop_id: "bunker-hill",
      title: "Bunker Hill Monument",
      lat: 42.3763,
      lng: -71.0611,
      google_place_id: "ChIJ123abc",
      image_url: "/images/bunker-hill.jpg",
    },
  ]);

  assert.equal(mappedStop.googlePlaceId, "ChIJ123abc");
  assert.equal(buildWalkDiscoveryCandidateKey(mappedStop), "place:chij123abc");
});
