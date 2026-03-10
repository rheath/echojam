import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { composeInstagramImportSourceText, estimateTextTokenCount, isInstagramDraftPublishable, nextInstagramDraftStatus, normalizeInstagramUrl, parseInstagramPublicMetadataFromHtml, resolveInstagramDraftScript, resolveInstagramDraftTitle, successJobStatusForPhase } from "../lib/instagramImport.ts";

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

test("estimateTextTokenCount returns an approximate token count", () => {
  assert.equal(estimateTextTokenCount(null), null);
  assert.equal(estimateTextTokenCount(""), null);
  assert.equal(estimateTextTokenCount("One two three four"), 5);
  assert.equal(estimateTextTokenCount("A".repeat(40)), 10);
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
});

test("publish readiness requires final content and confirmed place", () => {
  assert.equal(
    resolveInstagramDraftTitle({ generatedTitle: "Generated", editedTitle: "Edited" }),
    "Edited"
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
