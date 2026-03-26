import test from "node:test";
import assert from "node:assert/strict";
import { buildGooglePlaceIdPhotoUrl } from "@/lib/placesImages";
import { buildMixedComposerPlaceCandidates } from "@/lib/server/placeSearchCandidates";

test("search place candidate selection returns google place photo urls for valid place ids", () => {
  const candidates = buildMixedComposerPlaceCandidates(
    [
      {
        id: "google-place-1",
        displayName: { text: "Yvonne's" },
        location: { latitude: 42.3558, longitude: -71.0601 },
        formattedAddress: "2 Winter Pl, Boston, MA 02108, USA",
      },
    ],
    "/images/salem/placeholder.png",
    5
  );

  assert.equal(candidates[0]?.googlePlaceId, "google-place-1");
  assert.equal(candidates[0]?.image, buildGooglePlaceIdPhotoUrl("google-place-1"));
});

test("search place candidate selection falls back to the city placeholder when no valid place id exists", () => {
  const candidates = buildMixedComposerPlaceCandidates(
    [
      {
        displayName: { text: "Mystery Spot" },
        location: { latitude: 48.8566, longitude: 2.3522 },
      },
    ],
    "/images/salem/placeholder.png",
    5
  );

  assert.equal(candidates[0]?.googlePlaceId, undefined);
  assert.equal(candidates[0]?.image, "/images/salem/placeholder.png");
});
