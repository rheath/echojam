import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { PresetCitySeedSchema } from "../lib/presets/schema.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  attachPresetStopNarration,
  buildPresetPrompt,
  inferPresetStopBeat,
  resolvePresetRouteVoice,
  resolvePresetRouteVoiceForPersona,
  resolvePresetStopBrief,
} from "../lib/presetNarration.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { presetRouteData } from "../app/content/generated/presetRoutes.generated.ts";

test("preset schema accepts optional route voice and stop narration fields", () => {
  const parsed = PresetCitySeedSchema.parse({
    city: "nyc",
    routes: [
      {
        id: "hero-route",
        title: "Hero Route",
        durationMinutes: 30,
        description: "A dramatic city walk.",
        defaultPersona: "preteen",
        voice: {
          archetypeId: "hero-historian",
          displayName: "AI Explorer",
          basePersona: "preteen",
          ttsVoice: "nova",
          tone: ["cinematic", "fact-forward"],
          storyLens: "Use real places to explain how fictional cities became believable.",
          transitionStyle: "Point toward the next clue.",
          bannedPatterns: ["Do not use vague superhero filler."],
          openerFamilies: ["action-start", "look-closer"],
        },
        stops: [
          {
            placeId: "place-1",
            title: "Times Square",
            narration: {
              beat: "hook",
              angle: "Open big, then get concrete fast.",
              factBullets: ["A real fact."],
              mustMention: ["Times Square", "Marvel"],
              sensoryTargets: ["screens", "crowds"],
              contentPriority: "history_first",
            },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.routes[0]?.voice?.archetypeId, "hero-historian");
  assert.equal(parsed.routes[0]?.voice?.basePersona, "preteen");
  assert.equal(parsed.routes[0]?.stops?.[0]?.narration?.beat, "hook");
  assert.deepEqual(parsed.routes[0]?.stops?.[0]?.narration?.mustMention, ["Times Square", "Marvel"]);
});

test("legacy route and stop fields adapt into a usable route voice and stop brief", () => {
  const route = {
    id: "legacy-route",
    title: "Legacy Route",
    description: "Legacy route description.",
    durationMinutes: 30,
    defaultPersona: "preteen" as const,
    storyBy: "AI Explorer",
    narratorGuidance: "Keep this cinematic for kids, but let the facts lead.",
    contentPriority: "history_first" as const,
  };
  const stop = {
    id: "stop-1",
    title: "Times Square",
    lat: 0,
    lng: 0,
    image: "/images/salem/placeholder.png",
    narratorGuidance: "Start with spectacle, then explain the history.",
    mustMention: ["Times Square", "Marvel"],
    factBullets: ["Times Square already felt theatrical before superhero films."],
    contentPriority: "history_first" as const,
  };

  const routeVoice = resolvePresetRouteVoice(route);
  const stopBrief = resolvePresetStopBrief(route, stop, 1, 6);

  assert.equal(routeVoice.displayName, "AI Explorer");
  assert.equal(routeVoice.basePersona, "preteen");
  assert.equal(stopBrief.beat, "hook");
  assert.equal(stopBrief.angle, "Start with spectacle, then explain the history.");
  assert.deepEqual(stopBrief.mustMention, ["Times Square", "Marvel"]);
});

test("selected persona can override the route voice baseline without losing the route identity", () => {
  const route = {
    id: "hero-route",
    title: "Hero Route",
    description: "Real city, comic-book lens.",
    durationMinutes: 30,
    defaultPersona: "preteen" as const,
    storyBy: "AI Explorer",
    narratorGuidance: "Keep the route specific and energetic.",
    voice: {
      archetypeId: "hero-historian",
      displayName: "AI Explorer",
      basePersona: "preteen" as const,
      tone: ["cinematic", "fact-forward"],
      storyLens: "Explain how real places shaped superhero mythology.",
    },
  };

  const adultVoice = resolvePresetRouteVoiceForPersona(route, "adult");
  const preteenVoice = resolvePresetRouteVoiceForPersona(route, "preteen");

  assert.equal(adultVoice.basePersona, "adult");
  assert.equal(adultVoice.displayName, "AI Explorer");
  assert.equal(preteenVoice.basePersona, "preteen");
  assert.equal(preteenVoice.archetypeId, adultVoice.archetypeId);
});

test("beat fallback follows overview, hook, alternating middle beats, and payoff", () => {
  assert.equal(inferPresetStopBeat(0, 7, true), "overview");
  assert.equal(inferPresetStopBeat(1, 7, false), "hook");
  assert.equal(inferPresetStopBeat(2, 7, false), "reveal");
  assert.equal(inferPresetStopBeat(3, 7, false), "contrast");
  assert.equal(inferPresetStopBeat(6, 7, false), "payoff");
});

test("prompt builder keeps route voice stable, rotates adjacent opener families, and hardens factual requirements", () => {
  const route = {
    id: "hero-route",
    title: "Hero Route",
    description: "Real city, comic-book lens.",
    durationMinutes: 30,
    defaultPersona: "preteen" as const,
    storyBy: "AI Explorer",
    narratorGuidance: "Keep the route specific and energetic.",
    voice: {
      archetypeId: "hero-historian",
      displayName: "AI Explorer",
      basePersona: "preteen" as const,
      tone: ["cinematic", "fact-forward"],
      storyLens: "Explain how real places shaped superhero mythology.",
      transitionStyle: "Point to the next clue in the city's superhero story.",
      openerFamilies: ["action-start", "look-closer", "surprising-detail"],
    },
    contentPriority: "history_first" as const,
  };
  const stopA = {
    id: "stop-1",
    title: "Times Square",
    lat: 0,
    lng: 0,
    image: "/images/salem/placeholder.png",
    narration: {
      beat: "hook" as const,
      angle: "Open big, then get concrete fast.",
      mustMention: ["Times Square", "Marvel", "DC"],
      factBullets: [
        "Times Square already felt theatrical before superhero films.",
        "Marvel and DC used New York streets because the city was already dramatic.",
      ],
      contentPriority: "history_first" as const,
    },
  };
  const stopB = {
    id: "stop-2",
    title: "Flatiron Building",
    lat: 0,
    lng: 0,
    image: "/images/salem/placeholder.png",
    narration: {
      beat: "contrast" as const,
      angle: "Contrast the real skyline with fictional skylines.",
      mustMention: ["Flatiron Building", "Gotham"],
      factBullets: ["The building's wedge shape stood out early in Manhattan's skyline."],
      contentPriority: "history_first" as const,
    },
  };

  const promptA = buildPresetPrompt(route, stopA, "nyc", 1, 6);
  const promptB = buildPresetPrompt(route, stopB, "nyc", 2, 6);

  assert.equal(promptA.routeVoice.displayName, promptB.routeVoice.displayName);
  assert.equal(promptA.routeVoice.archetypeId, promptB.routeVoice.archetypeId);
  assert.notEqual(promptA.stopBrief.openerFamily, promptB.stopBrief.openerFamily);
  assert.match(promptA.userPrompt, /Move into concrete facts within the first 1-2 sentences\./);
  assert.match(promptA.userPrompt, /Use every exact name listed above at least once/);
  assert.match(promptA.userPrompt, /Times Square/);
  assert.match(promptA.userPrompt, /Marvel/);
  assert.match(promptA.userPrompt, /DC/);
  assert.match(promptA.userPrompt, /End with a reflective close tied to this place/);
  assert.doesNotMatch(promptA.userPrompt, /next clue/i);
  assert.match(promptA.userPrompt, /reflective payoff rooted in this place rather than another stop/i);
});

test("overview preset prompts launch reflectively without naming another stop", () => {
  const route = {
    id: "overview-route",
    title: "Boston Layers",
    description: "A citywide story.",
    durationMinutes: 30,
    defaultPersona: "adult" as const,
    narratorGuidance: "Keep it grounded and vivid.",
  };
  const stop = {
    id: "overview-stop",
    title: "Overview of Boston",
    lat: 0,
    lng: 0,
    image: "/images/salem/placeholder.png",
    isOverview: true,
  };

  const prompt = buildPresetPrompt(route, stop, "boston", 0, 5);

  assert.match(prompt.userPrompt, /reflective launch that frames the route's promise without naming another stop/i);
  assert.match(prompt.userPrompt, /Do not mention the next stop, continuing onward, or what comes next/i);
});

test("attachPresetStopNarration preserves overview stops and attaches authored narration by stop id", () => {
  const builtStops = [
    {
      id: "preset-overview-nyc",
      title: "Overview of New York City",
      lat: 0,
      lng: 0,
      image: "/images/salem/placeholder.png",
      contentPriority: "history_first" as const,
      isOverview: true,
    },
    {
      id: "preset-nyc-times-square",
      title: "Times Square",
      lat: 0,
      lng: 0,
      image: "/images/salem/placeholder.png",
      contentPriority: "history_first" as const,
      isOverview: false,
    },
  ];
  const routeStops = [
    {
      id: "preset-nyc-times-square",
      narration: {
        beat: "hook" as const,
      },
    },
  ];

  const attached = attachPresetStopNarration(builtStops, routeStops);

  assert.equal(attached[0]?.narration, null);
  assert.equal(attached[1]?.narration?.beat, "hook");
});

test("generated preset payload includes explicit voice and narration for nyc-superhero-city", () => {
  const route = presetRouteData.routes.find((candidate) => candidate.id === "nyc-superhero-city");
  assert.ok(route);
  assert.equal(route?.voice?.archetypeId, "superhero-city-historian");
  assert.equal(route?.voice?.basePersona, "preteen");
  assert.equal(route?.stops[0]?.narration?.beat, "hook");
  assert.deepEqual(route?.stops[5]?.narration?.sensoryTargets, [
    "cables overhead",
    "the East River below",
    "the long span between boroughs",
  ]);
});
