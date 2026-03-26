import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  normalizeMixedComposerSessionSnapshot,
  toMixedComposerSessionInsert,
  toMixedComposerSessionPatch,
} from "../lib/mixedComposerSession.ts";

test("mixed composer session preserves google place drafts across normalization", () => {
  const snapshot = normalizeMixedComposerSessionSnapshot({
    activeProvider: "google_places",
    customNarratorGuidance: "Young history guide",
    googlePlaceDraft: {
      place: {
        id: "place-1",
        title: "Boston Public Garden",
        lat: 42.354,
        lng: -71.07,
        image: "/placeholder.jpg",
        googlePlaceId: "g-1",
      },
      title: "Boston Public Garden",
      script: "The Public Garden turns a city stroll into a history scene.",
      status: "ready",
      error: null,
      scriptEditedByUser: false,
      generatedNarratorSignature: "custom:young history guide",
      generatedRouteSignature: "0:1",
    },
  });

  assert.equal(snapshot.googlePlaceDraft?.place.title, "Boston Public Garden");
  assert.equal(snapshot.googlePlaceDraft?.generatedNarratorSignature, "custom:young history guide");
  assert.equal(
    (
      toMixedComposerInsertOrPatch("insert", snapshot).google_place_draft as {
        status?: string;
      } | null
    )?.status,
    "ready"
  );
  assert.equal(toMixedComposerInsertOrPatch("patch", { googlePlaceDraft: null }).google_place_draft, null);
});

test("mixed composer session normalizes instagram draft collections", () => {
  const snapshot = normalizeMixedComposerSessionSnapshot({
    activeProvider: "instagram",
    instagramDraftId: "draft-2",
    instagramDraftIds: ["draft-1", "draft-2", "draft-1", "", null] as unknown as string[],
  });

  assert.deepEqual(snapshot.instagramDraftIds, ["draft-1", "draft-2"]);
  assert.equal(snapshot.instagramDraftId, "draft-2");
  assert.deepEqual(
    (toMixedComposerInsertOrPatch("insert", snapshot).instagram_draft_ids as string[] | undefined) ?? [],
    ["draft-1", "draft-2"]
  );
  assert.deepEqual(
    (toMixedComposerInsertOrPatch("patch", { instagramDraftIds: ["draft-3", "draft-3"] }).instagram_draft_ids as
      | string[]
      | undefined) ?? [],
    ["draft-3"]
  );
});

test("mixed composer session preserves instagram source preview images on restored stops", () => {
  const snapshot = normalizeMixedComposerSessionSnapshot({
    activeProvider: "instagram",
    stops: [
      {
        id: "instagram:draft-1",
        kind: "social_import",
        provider: "instagram",
        title: "Cholula Deli & Grill",
        lat: 40.7,
        lng: -73.9,
        image: "https://example.com/place-image.jpg",
        sourceUrl: "https://www.instagram.com/reel/abc123/",
        sourceId: "abc123",
        sourcePreviewImageUrl: "https://example.com/instagram-thumb.jpg",
        creatorName: "@letsfamilystyle",
        script: "Imported script",
      },
    ],
  });

  assert.equal(
    snapshot.stops[0]?.sourcePreviewImageUrl,
    "https://example.com/instagram-thumb.jpg"
  );
  assert.equal(
    (
      (toMixedComposerInsertOrPatch("insert", snapshot).stops as Array<{
        sourcePreviewImageUrl?: string | null;
      }>)?.[0]?.sourcePreviewImageUrl
    ) ?? null,
    "https://example.com/instagram-thumb.jpg"
  );
});

function toMixedComposerInsertOrPatch(
  mode: "insert" | "patch",
  value: Parameters<typeof normalizeMixedComposerSessionSnapshot>[0]
) {
  return mode === "insert" ? toMixedComposerSessionInsert(value) : toMixedComposerSessionPatch(value);
}
