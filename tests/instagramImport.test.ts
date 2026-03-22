import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  addInstagramCollectionDraftId,
  buildInstagramProfileUrl,
  buildInstagramScriptGenerationSourceText,
  canMasterPublishInstagramDrafts,
  composeInstagramImportSourceText,
  deriveInstagramRouteAttribution,
  deriveInstagramCollectionRouteTitle,
  estimateTextTokenCount,
  getInstagramCollectionDraftStatus,
  INSTAGRAM_COLLECTION_MAX_STOPS,
  INSTAGRAM_IMPORT_MAX_SPLIT_STOPS,
  isInstagramDraftPublishable,
  nextInstagramDraftStatus,
  normalizeInstagramImportJobDraftIds,
  normalizeInstagramUrl,
  normalizeInstagramCollectionDraftIds,
  parseInstagramTourStopConversions,
  parseInstagramPublicMetadataFromHtml,
  parseInstagramProfileImageUrlFromHtml,
  removeInstagramCollectionDraftId,
  resolveInstagramDraftScript,
  resolveInstagramDraftTitle,
  successJobStatusForPhase,
} from "../lib/instagramImport.ts";

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta property="og:title" content="KRISTIN + DAVID on Instagram: &quot;SAVE our dream Dolomites itinerary&quot;." />
    <meta name="twitter:title" content="KRISTIN + DAVID • Instagram reel" />
    <meta name="description" content="16K likes, 149 comments - upscaleadventurers on December 20, 2025: &quot;SAVE our dream Dolomites itinerary. Tre Cime di Lavaredo is our top stop.&quot;." />
    <meta name="twitter:image" content="https://example.com/thumb.jpg" />
    <meta property="instapp:owner_user_id" content="67638688334" />
  </head>
</html>
`;

const SAMPLE_POST_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta name="twitter:title" content="dave : familystyle (&#064;letsfamilystyle) &#x2022; Instagram reel" />
    <meta name="twitter:image" content="https://example.com/post-thumb.jpg" />
    <meta property="instapp:owner_user_id" content="52042280147" />
    <meta name="description" content="161K likes, 684 comments - letsfamilystyle on February 18, 2026: &quot;Noah is a rice FREAK LOL.&quot;." />
    <meta property="og:url" content="https://www.instagram.com/letsfamilystyle/reel/DU6Bzb2EeMm/" />
  </head>
</html>
`;

const SAMPLE_PROFILE_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta property="og:image" content="https://example.com/avatar.jpg" />
  </head>
</html>
`;

test("normalizeInstagramUrl accepts reels and posts", () => {
  assert.deepEqual(
    normalizeInstagramUrl("https://www.instagram.com/reels/DTaVqebjCkq/"),
    {
      normalizedUrl: "https://www.instagram.com/reels/DTaVqebjCkq/",
      sourceKind: "reel",
      shortcode: "DTaVqebjCkq",
    }
  );

  assert.deepEqual(
    normalizeInstagramUrl("instagram.com/p/ABC123xyz/"),
    {
      normalizedUrl: "https://www.instagram.com/p/ABC123xyz/",
      sourceKind: "post",
      shortcode: "ABC123xyz",
    }
  );

  assert.equal(normalizeInstagramUrl("https://www.instagram.com/stories/foo/bar"), null);
  assert.equal(normalizeInstagramUrl("https://example.com/reels/DTaVqebjCkq/"), null);
});

test("parseInstagramPublicMetadataFromHtml extracts caption and thumbnail", () => {
  const metadata = parseInstagramPublicMetadataFromHtml(SAMPLE_HTML);
  assert.equal(metadata.ownerTitle, "@upscaleadventurers");
  assert.equal(metadata.ownerUserId, "67638688334");
  assert.equal(
    metadata.caption,
    "SAVE our dream Dolomites itinerary. Tre Cime di Lavaredo is our top stop."
  );
  assert.equal(metadata.thumbnailUrl, "https://example.com/thumb.jpg");
});

test("parseInstagramPublicMetadataFromHtml handles public post owner fallbacks", () => {
  const metadata = parseInstagramPublicMetadataFromHtml(SAMPLE_POST_HTML);
  assert.equal(metadata.ownerTitle, "@letsfamilystyle");
  assert.equal(metadata.ownerUserId, "52042280147");
  assert.equal(metadata.thumbnailUrl, "https://example.com/post-thumb.jpg");
});

test("instagram attribution helpers derive profile links and collective labels", () => {
  assert.equal(
    buildInstagramProfileUrl("@letsfamilystyle"),
    "https://www.instagram.com/letsfamilystyle/"
  );
  assert.equal(
    parseInstagramProfileImageUrlFromHtml(SAMPLE_PROFILE_HTML),
    "https://example.com/avatar.jpg"
  );
  assert.deepEqual(
    deriveInstagramRouteAttribution([
      { ownerTitle: "@letsfamilystyle", profileImageUrl: "https://example.com/avatar.jpg" },
    ]),
    {
      storyBy: "@letsfamilystyle",
      storyByUrl: "https://www.instagram.com/letsfamilystyle/",
      storyByAvatarUrl: "https://example.com/avatar.jpg",
      storyBySource: "instagram",
      isCollective: false,
    }
  );
  assert.deepEqual(
    deriveInstagramRouteAttribution([
      { ownerTitle: "@letsfamilystyle" },
      { ownerTitle: "@nieves_cortes87" },
    ]),
    {
      storyBy: "Instagram creators",
      storyByUrl: null,
      storyByAvatarUrl: null,
      storyBySource: "instagram",
      isCollective: true,
    }
  );
});

test("composeInstagramImportSourceText falls back to caption and combines sources", () => {
  assert.equal(
    composeInstagramImportSourceText("Caption only", null),
    "Caption only"
  );
  assert.equal(
    composeInstagramImportSourceText("Caption only", "Transcript only"),
    "Transcript:\nTranscript only\n\nCaption:\nCaption only"
  );
});

test("buildInstagramScriptGenerationSourceText keeps transcript and caption as separate labeled inputs", () => {
  assert.equal(
    buildInstagramScriptGenerationSourceText({
      caption: "Caption only",
      transcript: null,
    }),
    "Caption:\nCaption only"
  );
  assert.equal(
    buildInstagramScriptGenerationSourceText({
      caption: null,
      transcript: "Transcript only",
    }),
    "Transcript:\nTranscript only"
  );
  assert.equal(
    buildInstagramScriptGenerationSourceText({
      caption: "Caption detail",
      transcript: "Transcript detail",
      cleanedText: "Cleaned detail",
    }),
    "Transcript:\nTranscript detail\n\nCaption:\nCaption detail\n\nCleaned notes:\nCleaned detail"
  );
});

test("estimateTextTokenCount returns an approximate token count", () => {
  assert.equal(estimateTextTokenCount(null), null);
  assert.equal(estimateTextTokenCount(""), null);
  assert.equal(estimateTextTokenCount("One two three four"), 5);
  assert.equal(estimateTextTokenCount("A".repeat(40)), 10);
});

test("collection draft helpers dedupe, remove, and respect the max stop count", () => {
  assert.deepEqual(
    normalizeInstagramCollectionDraftIds(["draft-1", "draft-2", "draft-1", "", null]),
    ["draft-1", "draft-2"]
  );
  assert.deepEqual(
    addInstagramCollectionDraftId(["draft-1", "draft-2"], "draft-3"),
    ["draft-1", "draft-2", "draft-3"]
  );
  assert.deepEqual(
    removeInstagramCollectionDraftId(["draft-1", "draft-2", "draft-3"], "draft-2"),
    ["draft-1", "draft-3"]
  );
  assert.deepEqual(
    addInstagramCollectionDraftId(
      Array.from({ length: INSTAGRAM_COLLECTION_MAX_STOPS }, (_, index) => `draft-${index + 1}`),
      "draft-overflow"
    ),
    Array.from({ length: INSTAGRAM_COLLECTION_MAX_STOPS }, (_, index) => `draft-${index + 1}`)
  );
});

test("collection publish helpers derive titles and ready states", () => {
  assert.equal(
    deriveInstagramCollectionRouteTitle(null, 1, "Single stop"),
    "Single stop"
  );
  assert.equal(
    deriveInstagramCollectionRouteTitle(null, 3, "Ignored"),
    "Instagram Route (3 stops)"
  );
  assert.equal(
    deriveInstagramCollectionRouteTitle("  Custom route  ", 3, "Ignored"),
    "Custom route"
  );
  assert.equal(
    getInstagramCollectionDraftStatus({
      status: "draft_ready",
      location: { publishReady: true },
    }),
    "ready"
  );
  assert.equal(
    getInstagramCollectionDraftStatus({
      status: "draft_ready",
      location: { publishReady: false },
    }),
    "needs_location"
  );
  assert.equal(
    canMasterPublishInstagramDrafts([
      { status: "draft_ready", location: { publishReady: true } },
      { status: "draft_ready", location: { publishReady: true } },
    ]),
    true
  );
  assert.equal(
    canMasterPublishInstagramDrafts([
      { status: "draft_ready", location: { publishReady: true } },
      { status: "published", location: { publishReady: true } },
    ]),
    true
  );
});

test("parseInstagramTourStopConversions accepts a single stop object and multi-stop arrays", () => {
  assert.deepEqual(
    parseInstagramTourStopConversions(
      JSON.stringify({
        title: "Single stop",
        script: "One narrated stop.",
        placeQuery: "North End Boston",
        cityHint: "Boston",
        countryHint: "USA",
        confidence: 0.91,
      })
    ),
    [
      {
        title: "Single stop",
        script: "One narrated stop.",
        placeQuery: "North End Boston",
        cityHint: "Boston",
        countryHint: "USA",
        confidence: 0.91,
      },
    ]
  );

  assert.deepEqual(
    parseInstagramTourStopConversions(
      JSON.stringify({
        stops: [
          {
            title: "Stop 1",
            script: "Script 1",
            placeQuery: "Boston Common",
            cityHint: "Boston",
            countryHint: "USA",
            confidence: 0.8,
          },
          {
            title: "Stop 2",
            script: "Script 2",
            placeQuery: "Beacon Hill Boston",
            cityHint: "Boston",
            countryHint: "USA",
            confidence: 0.7,
          },
        ],
      })
    ),
    [
      {
        title: "Stop 1",
        script: "Script 1",
        placeQuery: "Boston Common",
        cityHint: "Boston",
        countryHint: "USA",
        confidence: 0.8,
      },
      {
        title: "Stop 2",
        script: "Script 2",
        placeQuery: "Beacon Hill Boston",
        cityHint: "Boston",
        countryHint: "USA",
        confidence: 0.7,
      },
    ]
  );
});

test("parseInstagramTourStopConversions rejects malformed stops and caps output", () => {
  assert.throws(
    () =>
      parseInstagramTourStopConversions(
        JSON.stringify({
          stops: [{ title: "Missing script", placeQuery: "Boston" }],
        })
      ),
    /incomplete json/i
  );

  const overLimit = parseInstagramTourStopConversions(
    JSON.stringify({
      stops: Array.from({ length: INSTAGRAM_IMPORT_MAX_SPLIT_STOPS + 2 }, (_, index) => ({
        title: `Stop ${index + 1}`,
        script: `Script ${index + 1}`,
        placeQuery: `Place ${index + 1}`,
        cityHint: "Boston",
        countryHint: "USA",
        confidence: 0.5,
      })),
    })
  );
  assert.equal(overLimit.length, INSTAGRAM_IMPORT_MAX_SPLIT_STOPS);
  assert.equal(overLimit[0]?.title, "Stop 1");
  assert.equal(overLimit.at(-1)?.title, `Stop ${INSTAGRAM_IMPORT_MAX_SPLIT_STOPS}`);
});

test("normalizeInstagramImportJobDraftIds preserves multi-stop imports and single-stop publish jobs", () => {
  assert.deepEqual(
    normalizeInstagramImportJobDraftIds("import", "draft-1", ["draft-1", "draft-2", "draft-3"]),
    ["draft-1", "draft-2", "draft-3"]
  );
  assert.deepEqual(
    normalizeInstagramImportJobDraftIds("publish", "draft-9", null),
    ["draft-9"]
  );
});

test("draft status transitions follow import and publish lifecycle", () => {
  assert.equal(nextInstagramDraftStatus("pending_import", "import_started"), "importing");
  assert.equal(nextInstagramDraftStatus("importing", "import_succeeded"), "draft_ready");
  assert.equal(nextInstagramDraftStatus("draft_ready", "publish_started"), "publishing");
  assert.equal(nextInstagramDraftStatus("publishing", "publish_succeeded"), "published");
  assert.equal(nextInstagramDraftStatus("publishing", "job_failed"), "failed");
  assert.equal(nextInstagramDraftStatus("published", "job_failed"), "published");
  assert.equal(successJobStatusForPhase("import"), "draft_ready");
  assert.equal(successJobStatusForPhase("publish"), "published");
  assert.equal(successJobStatusForPhase("publish_collection"), "published");
});

test("publish readiness requires final content and confirmed place", () => {
  assert.equal(
    resolveInstagramDraftTitle({ generatedTitle: "Generated", editedTitle: "Edited" }),
    "Edited"
  );
  assert.equal(
    resolveInstagramDraftScript({ generatedScript: "Generated script", editedScript: "Edited script" }),
    "Edited script"
  );
  assert.equal(
    resolveInstagramDraftScript({ generatedScript: "Generated script", editedScript: null }),
    "Generated script"
  );
  assert.equal(
    isInstagramDraftPublishable({
      generatedTitle: "Stop title",
      generatedScript: "Stop script",
      confirmedPlaceLabel: "Tre Cime di Lavaredo",
      confirmedPlaceLat: 46.6183,
      confirmedPlaceLng: 12.3007,
    }),
    true
  );
  assert.equal(
    isInstagramDraftPublishable({
      generatedTitle: "Stop title",
      generatedScript: "Stop script",
      confirmedPlaceLabel: null,
      confirmedPlaceLat: 46.6183,
      confirmedPlaceLng: 12.3007,
    }),
    false
  );
});
