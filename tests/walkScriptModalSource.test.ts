import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { buildWalkScriptModalSourceLink } from "../lib/walkScriptModalSource.ts";

test("walk script modal source link returns instagram metadata", () => {
  const result = buildWalkScriptModalSourceLink({
    sourceProvider: "instagram",
    sourceUrl: "https://www.instagram.com/reel/abc123/",
    images: ["https://example.com/preview.jpg"],
  });

  assert.deepEqual(result, {
    provider: "instagram",
    href: "https://www.instagram.com/reel/abc123/",
    imageSrc: "https://example.com/preview.jpg",
    title: "Instagram source",
    description: "View the original Instagram post for this stop.",
    ctaLabel: "Open Instagram",
  });
});

test("walk script modal source link prefers the saved social preview image", () => {
  const result = buildWalkScriptModalSourceLink({
    sourceProvider: "instagram",
    sourceUrl: "https://www.instagram.com/reel/abc123/",
    sourcePreviewImageUrl: "https://example.com/instagram-preview.jpg",
    images: ["https://example.com/place-preview.jpg"],
  });

  assert.deepEqual(result, {
    provider: "instagram",
    href: "https://www.instagram.com/reel/abc123/",
    imageSrc: "https://example.com/instagram-preview.jpg",
    title: "Instagram source",
    description: "View the original Instagram post for this stop.",
    ctaLabel: "Open Instagram",
  });
});

test("walk script modal source link returns tiktok metadata", () => {
  const result = buildWalkScriptModalSourceLink({
    sourceProvider: "tiktok",
    sourceUrl: "https://www.tiktok.com/@guide/video/123",
    images: ["/images/local-preview.png"],
  });

  assert.deepEqual(result, {
    provider: "tiktok",
    href: "https://www.tiktok.com/@guide/video/123",
    imageSrc: "/images/local-preview.png",
    title: "TikTok source",
    description: "Open the original TikTok that inspired this stop.",
    ctaLabel: "Open on TikTok",
  });
});

test("walk script modal source link ignores google places stops", () => {
  const result = buildWalkScriptModalSourceLink({
    sourceProvider: "google_places",
    sourceUrl: "https://maps.google.com/?q=place",
    images: ["https://example.com/place.jpg"],
  });

  assert.equal(result, null);
});

test("walk script modal source link requires a valid source url", () => {
  assert.equal(
    buildWalkScriptModalSourceLink({
      sourceProvider: "instagram",
      sourceUrl: "   ",
      images: ["https://example.com/preview.jpg"],
    }),
    null
  );

  assert.equal(
    buildWalkScriptModalSourceLink({
      sourceProvider: "tiktok",
      sourceUrl: "notaurl",
      images: ["https://example.com/preview.jpg"],
    }),
    null
  );
});

test("walk script modal source link falls back to the safe default image", () => {
  const result = buildWalkScriptModalSourceLink({
    sourceProvider: "instagram",
    sourceUrl: "https://www.instagram.com/p/xyz987/",
    images: [""],
  });

  assert.deepEqual(result, {
    provider: "instagram",
    href: "https://www.instagram.com/p/xyz987/",
    imageSrc: "/images/salem/placeholder.png",
    title: "Instagram source",
    description: "View the original Instagram post for this stop.",
    ctaLabel: "Open Instagram",
  });
});
