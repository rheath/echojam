import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  createGooglePlaceDraft,
  createGooglePlaceNarratorSignature,
  createGooglePlaceRouteSignature,
  deriveComposerRouteAttribution,
  isGooglePlaceStopScriptStale,
  mapGooglePlaceCandidateToComposerStop,
  mapGooglePlaceDraftToComposerStop,
  mapSocialDraftToComposerStop,
} from "../lib/socialComposer.ts";

test("mapSocialDraftToComposerStop uses confirmed place and final script for instagram drafts", () => {
  const stop = mapSocialDraftToComposerStop("instagram", {
    id: "draft-1",
    source: {
      url: "https://www.instagram.com/reels/ABC123/",
      shortcode: "ABC123",
      ownerTitle: "@letsfamilystyle",
      thumbnailUrl: "https://example.com/thumb.jpg",
    },
    content: {
      finalTitle: "North End Cannoli Stop",
      generatedTitle: null,
      finalScript: "Walk into the North End and follow the smell of pastry.",
      generatedScript: null,
    },
    location: {
      confirmedPlace: {
        label: "Mike's Pastry",
        lat: 42.3634,
        lng: -71.0541,
        imageUrl: "https://example.com/place.jpg",
        googlePlaceId: "place-1",
      },
    },
  });

  assert.deepEqual(stop, {
    id: "instagram:draft-1",
    kind: "social_import",
    provider: "instagram",
    title: "North End Cannoli Stop",
    lat: 42.3634,
    lng: -71.0541,
    image: "https://example.com/place.jpg",
    googlePlaceId: "place-1",
    sourceUrl: "https://www.instagram.com/reels/ABC123/",
    sourceId: "ABC123",
    creatorName: "@letsfamilystyle",
    creatorUrl: "https://www.instagram.com/letsfamilystyle/",
    creatorAvatarUrl: null,
    script: "Walk into the North End and follow the smell of pastry.",
    originalDraftId: "draft-1",
  });
});

test("mapSocialDraftToComposerStop keeps Instagram stops from the same reel distinct by draft id", () => {
  const first = mapSocialDraftToComposerStop("instagram", {
    id: "draft-1",
    source: {
      url: "https://www.instagram.com/reels/ABC123/",
      shortcode: "ABC123",
      ownerTitle: "@letsfamilystyle",
      thumbnailUrl: "https://example.com/thumb.jpg",
    },
    content: {
      finalTitle: "Stop 1",
      generatedTitle: null,
      finalScript: "Script 1",
      generatedScript: null,
    },
    location: {
      confirmedPlace: {
        label: "Place 1",
        lat: 42.1,
        lng: -71.1,
        imageUrl: "https://example.com/1.jpg",
        googlePlaceId: "place-1",
      },
    },
  });
  const second = mapSocialDraftToComposerStop("instagram", {
    id: "draft-2",
    source: {
      url: "https://www.instagram.com/reels/ABC123/",
      shortcode: "ABC123",
      ownerTitle: "@letsfamilystyle",
      thumbnailUrl: "https://example.com/thumb.jpg",
    },
    content: {
      finalTitle: "Stop 2",
      generatedTitle: null,
      finalScript: "Script 2",
      generatedScript: null,
    },
    location: {
      confirmedPlace: {
        label: "Place 2",
        lat: 42.2,
        lng: -71.2,
        imageUrl: "https://example.com/2.jpg",
        googlePlaceId: "place-2",
      },
    },
  });

  assert.equal(first?.id, "instagram:draft-1");
  assert.equal(second?.id, "instagram:draft-2");
  assert.equal(first?.sourceId, "ABC123");
  assert.equal(second?.sourceId, "ABC123");
});

test("deriveComposerRouteAttribution collapses multiple creators into a social label", () => {
  const attribution = deriveComposerRouteAttribution([
    {
      id: "instagram:1",
      kind: "social_import",
      provider: "instagram",
      title: "A",
      lat: 1,
      lng: 1,
      image: "a",
      creatorName: "@alpha",
      creatorUrl: "https://www.instagram.com/alpha/",
    },
    {
      id: "tiktok:2",
      kind: "social_import",
      provider: "tiktok",
      title: "B",
      lat: 2,
      lng: 2,
      image: "b",
      creatorName: "@beta",
      creatorUrl: "https://www.tiktok.com/@beta",
    },
    mapGooglePlaceCandidateToComposerStop({
      id: "place-1",
      title: "Boston Public Garden",
      lat: 3,
      lng: 3,
      image: "/placeholder.jpg",
      googlePlaceId: "g-1",
    }),
  ]);

  assert.deepEqual(attribution, {
    storyBy: "Social creators",
    storyByUrl: null,
    storyByAvatarUrl: null,
    storyBySource: "social",
  });
});

test("google place draft helpers create signatures and preserve generated metadata", () => {
  const narratorSignature = createGooglePlaceNarratorSignature("Young history guide");
  const routeSignature = createGooglePlaceRouteSignature(2, 4);
  const draft = createGooglePlaceDraft(
    {
      id: "place-1",
      title: "Boston Public Garden",
      lat: 42.354,
      lng: -71.07,
      image: "/placeholder.jpg",
      googlePlaceId: "g-1",
    },
    narratorSignature,
    routeSignature
  );

  const stop = mapGooglePlaceDraftToComposerStop({
    ...draft,
    script: "Here the Public Garden turns Boston history into a living postcard.",
    status: "ready",
  });

  assert.equal(narratorSignature, "custom:young history guide");
  assert.equal(routeSignature, "2:4");
  assert.equal(stop.scriptEditedByUser, false);
  assert.equal(stop.generatedNarratorSignature, narratorSignature);
  assert.equal(stop.generatedRouteSignature, routeSignature);
});

test("google place stale detection only refreshes untouched AI drafts", () => {
  const staleStop = mapGooglePlaceDraftToComposerStop({
    ...createGooglePlaceDraft(
      {
        id: "place-2",
        title: "TD Garden",
        lat: 42.3662,
        lng: -71.0621,
        image: "/placeholder.jpg",
        googlePlaceId: "g-2",
      },
      createGooglePlaceNarratorSignature("History for young listeners"),
      createGooglePlaceRouteSignature(0, 1)
    ),
    script: "TD Garden carries a much older Boston story than its name suggests.",
    status: "ready",
  });

  assert.equal(
    isGooglePlaceStopScriptStale(
      staleStop,
      createGooglePlaceNarratorSignature("History for young listeners"),
      createGooglePlaceRouteSignature(1, 2)
    ),
    true
  );

  assert.equal(
    isGooglePlaceStopScriptStale(
      {
        ...staleStop,
        scriptEditedByUser: true,
      },
      createGooglePlaceNarratorSignature("History for young listeners"),
      createGooglePlaceRouteSignature(1, 2)
    ),
    false
  );
});
