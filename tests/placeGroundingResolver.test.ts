import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { resolvePlaceGrounding } from "../lib/server/placeGroundingResolver.ts";

test("resolvePlaceGrounding uses Google place details and reverse geocode context", async () => {
  const originalFetch = global.fetch;
  process.env.GOOGLE_PLACES_API_KEY = "test-key";

  try {
    global.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("places.googleapis.com/v1/places/")) {
        return new Response(
          JSON.stringify({
            displayName: { text: "Cholula Deli and Grill" },
            formattedAddress: "222 Wyckoff Ave, Brooklyn, NY 11237, USA",
            location: { latitude: 40.704, longitude: -73.922 },
            types: ["restaurant", "food"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          results: [
            {
              address_components: [
                { long_name: "Bushwick", types: ["neighborhood"] },
                { long_name: "Brooklyn", types: ["sublocality_level_1"] },
                { long_name: "New York City", types: ["locality"] },
                { long_name: "New York", types: ["administrative_area_level_1"] },
                { long_name: "United States", types: ["country"] },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const grounding = await resolvePlaceGrounding({
      title: "Cholula Deli and Grill",
      googlePlaceId: "g-1",
      lat: 40.704,
      lng: -73.922,
    });

    assert.ok(grounding);
    assert.equal(grounding?.resolvedName, "Cholula Deli and Grill");
    assert.equal(grounding?.venueCategory, "Restaurant");
    assert.equal(grounding?.neighborhood, "Bushwick");
    assert.equal(grounding?.city, "New York City");
    assert.equal(grounding?.region, "New York");
    assert.equal(grounding?.country, "United States");
    assert.match(String(grounding?.localContext), /Restaurant/);
    assert.equal(grounding?.source, "google_place_details");
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolvePlaceGrounding falls back to reverse geocode when place details are unavailable", async () => {
  const originalFetch = global.fetch;
  process.env.GOOGLE_PLACES_API_KEY = "test-key";

  try {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              address_components: [
                { long_name: "Downtown", types: ["neighborhood"] },
                { long_name: "Boston", types: ["locality"] },
                { long_name: "Massachusetts", types: ["administrative_area_level_1"] },
                { long_name: "United States", types: ["country"] },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const grounding = await resolvePlaceGrounding({
      title: "Old State House",
      lat: 42.3588,
      lng: -71.0579,
    });

    assert.ok(grounding);
    assert.equal(grounding?.resolvedName, "Old State House");
    assert.equal(grounding?.neighborhood, "Downtown");
    assert.equal(grounding?.city, "Boston");
    assert.equal(grounding?.source, "reverse_geocode");
  } finally {
    global.fetch = originalFetch;
  }
});
