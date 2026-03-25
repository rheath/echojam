import test from "node:test";
import assert from "node:assert/strict";
import {
  discoveryPrimaryTypesForThemes,
  inferDiscoveryThemes,
  scoreDiscoveryThemeMatch,
} from "@/lib/discoveryThemes";

test("inferDiscoveryThemes prefers explicit route themes", () => {
  assert.deepEqual(
    inferDiscoveryThemes({
      discoveryThemes: ["animals"],
      title: "History Walk",
      description: "Historic landmarks",
    }),
    ["animals"]
  );
});

test("inferDiscoveryThemes falls back to route copy when explicit themes are absent", () => {
  assert.deepEqual(
    inferDiscoveryThemes({
      title: "Superheroes of NYC",
      description: "A comic-book adventure through Midtown.",
      narratorGuidance: "Keep real comic-book history specific and concrete.",
    }),
    ["comics"]
  );
});

test("discoveryPrimaryTypesForThemes unions themed nearby place types", () => {
  assert.deepEqual(
    discoveryPrimaryTypesForThemes(["history", "architecture"]),
    [
      "tourist_attraction",
      "museum",
      "historical_landmark",
      "monument",
      "church",
      "library",
      "visitor_center",
      "art_gallery",
      "plaza",
    ]
  );
});

test("scoreDiscoveryThemeMatch rewards keyword and primary type alignment", () => {
  const score = scoreDiscoveryThemeMatch(
    {
      title: "Historic Harbor Museum",
      primaryType: "museum",
      types: ["tourist_attraction"],
    },
    ["history"]
  );

  assert.ok(score > 0);
});
