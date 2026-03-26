import test from "node:test";
import assert from "node:assert/strict";
import { buildGooglePlaceIdPhotoUrl } from "@/lib/placesImages";
import { pickCustomRouteStopImage } from "@/lib/server/customRouteStopImages";

test("custom route image selection falls back to google place photo when stored images are placeholders", () => {
  const imageUrl = pickCustomRouteStopImage({
    canonicalImage: null,
    placeIdPhoto: buildGooglePlaceIdPhotoUrl("google-place-1"),
    curatedFallback: null,
    stopImage: "/images/salem/placeholder.png",
    canonicalSource: "placeholder",
    placeholder: "/images/salem/placeholder.png",
  });

  assert.equal(imageUrl, buildGooglePlaceIdPhotoUrl("google-place-1"));
});

test("custom route image selection keeps placeholder fallback when no strong image exists", () => {
  const imageUrl = pickCustomRouteStopImage({
    canonicalImage: null,
    placeIdPhoto: null,
    curatedFallback: null,
    stopImage: "/images/salem/placeholder.png",
    canonicalSource: "placeholder",
    placeholder: "/images/salem/placeholder.png",
  });

  assert.equal(imageUrl, "/images/salem/placeholder.png");
});
