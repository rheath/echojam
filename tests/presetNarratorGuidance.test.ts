import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { PresetCitySeedSchema } from "../lib/presets/schema.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { buildStructuredStopPromptConfig, extractGuidanceReferenceTargets } from "../lib/mixGeneration.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { mergePresetNarratorGuidance } from "../lib/presetRouteAssets.ts";

test("preset schema accepts optional structured content fields", () => {
  const parsed = PresetCitySeedSchema.parse({
    city: "nyc",
    routes: [
      {
        id: "hero-route",
        title: "Hero Route",
        durationMinutes: 30,
        description: "A dramatic city walk.",
        defaultPersona: "preteen",
        narratorGuidance: "Tell this like a comic-book adventure.",
        contentPriority: "history_first",
        stops: [
          {
            placeId: "place-1",
            title: "Times Square",
            narratorGuidance: "Open with maximum energy.",
            mustMention: ["Spider-Man", "Marvel"],
            factBullets: ["Times Square's spectacle made it feel like a ready-made comic-book stage."],
          },
        ],
      },
    ],
  });

  assert.equal(parsed.routes[0]?.narratorGuidance, "Tell this like a comic-book adventure.");
  assert.equal(parsed.routes[0]?.contentPriority, "history_first");
  assert.equal(parsed.routes[0]?.stops?.[0]?.narratorGuidance, "Open with maximum energy.");
  assert.deepEqual(parsed.routes[0]?.stops?.[0]?.mustMention, ["Spider-Man", "Marvel"]);
  assert.deepEqual(parsed.routes[0]?.stops?.[0]?.factBullets, [
    "Times Square's spectacle made it feel like a ready-made comic-book stage.",
  ]);
});

test("preset schema still accepts legacy stopPlaceIds routes", () => {
  const parsed = PresetCitySeedSchema.parse({
    city: "nyc",
    routes: [
      {
        id: "legacy-route",
        title: "Legacy Route",
        durationMinutes: 25,
        description: "Legacy stop ids only.",
        defaultPersona: "adult",
        stopPlaceIds: ["place-1", "place-2"],
      },
    ],
  });

  assert.deepEqual(parsed.routes[0]?.stopPlaceIds, ["place-1", "place-2"]);
});

test("mergePresetNarratorGuidance combines route and stop guidance in order", () => {
  assert.equal(
    mergePresetNarratorGuidance("Kid-focused storytelling.", "Make this stop feel like the opening scene."),
    "Use the overall route guidance as the baseline voice, but prioritize the stop-specific guidance for this stop.\nIf the stop-specific guidance includes named examples, characters, places, or fictional worlds, mention at least one of them explicitly in the narration when it fits naturally.\nOverall route guidance: Kid-focused storytelling.\nStop-specific guidance (highest priority): Make this stop feel like the opening scene."
  );
  assert.equal(
    mergePresetNarratorGuidance(null, "Focus on the strange detail."),
    "If the stop-specific guidance includes named examples, characters, places, or fictional worlds, mention at least one of them explicitly in the narration when it fits naturally.\nStop-specific guidance (highest priority): Focus on the strange detail."
  );
  assert.equal(mergePresetNarratorGuidance("Set a spooky mood.", null), "Overall route guidance: Set a spooky mood.");
});

test("extractGuidanceReferenceTargets keeps specific fictional references from stop guidance", () => {
  assert.deepEqual(
    extractGuidanceReferenceTargets(
      "Turn the Flatiron Building into a mysterious headquarters or secret base. Talk about its unusual triangle shape and explain how unique buildings like this inspired the dramatic skylines seen in comic cities like Batman's Gotham and Superman's Metropolis.",
      "Flatiron Building"
    ),
    ["Batman Gotham", "Batman", "Gotham", "Superman Metropolis", "Superman", "Metropolis"]
  );
});

test("buildStructuredStopPromptConfig prioritizes exact names and fact beats for history-first stops", () => {
  const config = buildStructuredStopPromptConfig(
    {
      title: "Flatiron Building",
      contentPriority: "history_first",
      mustMention: ["Batman", "Gotham", "Superman", "Metropolis"],
      factBullets: [
        "The Flatiron Building's triangle shape made it one of New York's most distinctive early skyscrapers.",
        "Dramatic skyline forms like this helped artists imagine fictional comic-book skylines such as Gotham and Metropolis.",
      ],
    },
    "Keep it cinematic for kids."
  );

  assert.equal(config.contentPriority, "history_first");
  assert.deepEqual(config.mustMention, ["Batman", "Gotham", "Superman", "Metropolis"]);
  assert.equal(config.factBullets.length, 2);
  assert.ok(
    config.promptSections.includes("Content priority: history-first. Real comic-book history and NYC influence come before cinematic scene-setting.")
  );
  assert.ok(
    config.extraRequirements.includes("- Mention at least one of these exact names verbatim: Batman, Gotham, Superman, Metropolis.")
  );
  assert.ok(
    config.extraRequirements.includes(
      "- Include at least 2 of the required fact beats below in clear, concrete language."
    )
  );
});
