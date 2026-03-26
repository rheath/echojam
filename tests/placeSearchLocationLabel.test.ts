import test from "node:test";
import assert from "node:assert/strict";
import { buildMixedComposerPlaceCandidate } from "@/lib/server/placeSearchCandidates";
import { searchInstagramImportPlacesByQuery } from "@/lib/server/instagramImportWorker";
import { searchTikTokImportPlacesByQuery } from "@/lib/server/tiktokImportWorker";
import { buildGooglePlaceIdPhotoUrl } from "@/lib/placesImages";

function createPlacesResponse() {
  return {
    places: [
      {
        id: "place-1",
        displayName: { text: "Yvonne's" },
        location: { latitude: 42.3558, longitude: -71.0601 },
        formattedAddress: "2 Winter Pl, Boston, MA 02108, USA",
        addressComponents: [
          { longText: "Boston", shortText: "Boston", types: ["locality"] },
          {
            longText: "Massachusetts",
            shortText: "MA",
            types: ["administrative_area_level_1"],
          },
          { longText: "United States", shortText: "US", types: ["country"] },
        ],
      },
    ],
  };
}

test("maps place candidate mapping includes locationLabel", () => {
  const candidate = buildMixedComposerPlaceCandidate(
    createPlacesResponse().places[0],
    "/images/salem/placeholder.png"
  );

  assert.equal(candidate?.title, "Yvonne's");
  assert.equal(candidate?.locationLabel, "Boston, MA");
  assert.equal(candidate?.image, buildGooglePlaceIdPhotoUrl("place-1"));
});

test("maps place candidate mapping falls back to placeholder without a valid google place id", () => {
  const candidate = buildMixedComposerPlaceCandidate(
    {
      displayName: { text: "Mystery Spot" },
      location: { latitude: 48.8566, longitude: 2.3522 },
    },
    "/images/salem/placeholder.png"
  );

  assert.equal(candidate?.image, "/images/salem/placeholder.png");
});

test("instagram search results include locationLabel", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async () =>
    new Response(JSON.stringify(createPlacesResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const candidates = await searchInstagramImportPlacesByQuery("yvonne's", "Boston", "USA", 5);

  assert.equal(candidates[0]?.label, "Yvonne's");
  assert.equal(candidates[0]?.locationLabel, "Boston, MA");
});

test("tiktok search results keep locationLabel null when metadata is missing", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GOOGLE_PLACES_API_KEY;

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        places: [
          {
            id: "place-2",
            displayName: { text: "Mystery Spot" },
            location: { latitude: 48.8566, longitude: 2.3522 },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_PLACES_API_KEY = originalApiKey;
  });

  const candidates = await searchTikTokImportPlacesByQuery("mystery spot", null, null, 5);

  assert.equal(candidates[0]?.label, "Mystery Spot");
  assert.equal(candidates[0]?.locationLabel, null);
});
