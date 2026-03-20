type PresetPersona = "adult" | "preteen" | "ghost";
type PresetContentPriority = "default" | "history_first";
type PresetNarrationBeat = "overview" | "hook" | "reveal" | "contrast" | "payoff";
type PresetTtsVoice = "alloy" | "nova" | "shimmer" | "onyx";

export type PresetRouteVoiceSeed = {
  archetypeId: string;
  displayName?: string | null;
  basePersona: PresetPersona;
  ttsVoice?: PresetTtsVoice | null;
  tone?: string[] | null;
  storyLens?: string | null;
  transitionStyle?: string | null;
  bannedPatterns?: string[] | null;
  openerFamilies?: string[] | null;
};

export type PresetStopNarrationSeed = {
  beat?: PresetNarrationBeat | null;
  angle?: string | null;
  factBullets?: string[] | null;
  mustMention?: string[] | null;
  sensoryTargets?: string[] | null;
  contentPriority?: PresetContentPriority | null;
};

export type PresetNarrationRouteInput = {
  id: string;
  title: string;
  description: string;
  durationMinutes?: number;
  defaultPersona: PresetPersona | "custom";
  storyBy?: string | null;
  narratorGuidance?: string | null;
  contentPriority?: PresetContentPriority | null;
  voice?: PresetRouteVoiceSeed | null;
};

export type PresetNarrationStopInput = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  googlePlaceId?: string;
  narratorGuidance?: string | null;
  mustMention?: string[] | null;
  factBullets?: string[] | null;
  contentPriority?: PresetContentPriority | null;
  isOverview?: boolean;
  narration?: PresetStopNarrationSeed | null;
};

export type PresetNarrationStopWithNarration<T extends Omit<PresetNarrationStopInput, "narration">> = T & {
  narration?: PresetStopNarrationSeed | null;
};

export type ResolvedRouteVoice = {
  archetypeId: string;
  displayName: string;
  basePersona: PresetPersona;
  ttsVoice: PresetTtsVoice;
  tone: string[];
  storyLens: string;
  transitionStyle: string;
  bannedPatterns: string[];
  openerFamilies: string[];
};

export type ResolvedStopBrief = {
  beat: PresetNarrationBeat;
  angle: string | null;
  factBullets: string[];
  mustMention: string[];
  sensoryTargets: string[];
  contentPriority: PresetContentPriority;
  openerFamily: string;
};

const VOICE_BY_PERSONA: Record<PresetPersona, PresetTtsVoice> = {
  adult: "alloy",
  preteen: "nova",
  ghost: "alloy",
};

const PERSONA_DISPLAY_NAME: Record<PresetPersona, string> = {
  adult: "AI Historian",
  preteen: "AI Explorer",
  ghost: "AI Ghost Guide",
};

const PERSONA_TONE: Record<PresetPersona, string[]> = {
  adult: ["confident", "cinematic", "historically grounded"],
  preteen: ["curious", "adventurous", "clear"],
  ghost: ["calm", "intimate", "quietly unsettling"],
};

const PERSONA_STORY_LENS: Record<PresetPersona, string> = {
  adult: "Connect place, people, consequence, and what still matters now.",
  preteen: "Make the listener feel like they are uncovering something real and exciting.",
  ghost: "Hold the line between documented history and the stories that linger around it.",
};

const PERSONA_TRANSITION_STYLE: Record<PresetPersona, string> = {
  adult: "Point clearly toward what the next stop reveals without sounding repetitive.",
  preteen: "End with momentum and curiosity, like the listener is chasing the next clue.",
  ghost: "End with a soft sense that the route is drawing the listener deeper.",
};

const PERSONA_OPENERS: Record<PresetPersona, string[]> = {
  adult: ["history-anchor", "surprising-detail", "present-day-contrast"],
  preteen: ["action-start", "secret-clue", "look-closer"],
  ghost: ["subtle-unease", "documented-fact-first", "watchful-detail"],
};

const PERSONA_BANNED_PATTERNS: Record<PresetPersona, string[]> = {
  adult: [
    "Do not use placeholders, bracketed notes, or stage directions.",
    "Do not say 'as an AI'.",
    "Do not pad the stop with generic travel-writing filler.",
  ],
  preteen: [
    "Do not use placeholders, bracketed notes, or stage directions.",
    "Do not use baby talk or dated slang.",
    "Do not pad the stop with generic adventure fluff.",
  ],
  ghost: [
    "Do not use placeholders, bracketed notes, or stage directions.",
    "Do not present folklore as proven fact.",
    "Do not pad the stop with haunted-house cliches.",
  ],
};

function toNullableTrimmed(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeStringArray(value: string[] | readonly string[] | null | undefined) {
  if (!Array.isArray(value)) return [] as string[];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function toPresetPersona(value: PresetNarrationRouteInput["defaultPersona"]): PresetPersona {
  return value === "preteen" || value === "ghost" ? value : "adult";
}

function toContentPriority(value: string | null | undefined): PresetContentPriority {
  return value === "history_first" ? "history_first" : "default";
}

function pickRotatingValue(values: string[], index: number, fallback: string) {
  if (values.length === 0) return fallback;
  return values[((index % values.length) + values.length) % values.length] || fallback;
}

function openerInstruction(openerFamily: string, beat: PresetNarrationBeat) {
  if (openerFamily === "history-anchor") {
    return "Open with one concrete historical or cultural anchor before expanding outward.";
  }
  if (openerFamily === "surprising-detail") {
    return "Open with a surprising concrete detail that earns attention immediately.";
  }
  if (openerFamily === "present-day-contrast") {
    return "Open by contrasting the present-day scene with what this place has meant before.";
  }
  if (openerFamily === "action-start") {
    return "Open as if the listener has just stepped into an active scene or mission.";
  }
  if (openerFamily === "secret-clue") {
    return "Open with one clue-like detail that makes the listener want the explanation.";
  }
  if (openerFamily === "look-closer") {
    return "Open by directing attention to one concrete detail most people miss.";
  }
  if (openerFamily === "subtle-unease") {
    return "Open with a detail that feels slightly off without using horror cliches.";
  }
  if (openerFamily === "documented-fact-first") {
    return "Open with one verified fact, then let the atmosphere gather around it.";
  }
  if (openerFamily === "watchful-detail") {
    return "Open with one architectural or sensory detail that feels quietly watchful.";
  }
  if (beat === "overview") {
    return "Open by setting the route-wide promise and why this city or theme matters.";
  }
  return "Open with a concrete, specific detail instead of a generic scene-setting sentence.";
}

function transitionInstruction(transitionStyle: string, stopIndex: number, totalStops: number, isOverview: boolean) {
  if (isOverview) {
    return "End by launching the route and making the first landmark feel inevitable.";
  }
  if (stopIndex >= totalStops - 1) {
    return "End with payoff and closure rather than teasing another stop.";
  }
  return transitionStyle;
}

function lengthTarget(basePersona: PresetPersona) {
  if (basePersona === "preteen") {
    return {
      durationSeconds: "75-110",
      sentenceRange: "7-9",
      wordRange: "180-260",
    };
  }
  return {
    durationSeconds: "75-110",
    sentenceRange: "6-8",
    wordRange: "170-240",
  };
}

export function inferPresetStopBeat(stopIndex: number, totalStops: number, isOverview = false): PresetNarrationBeat {
  if (isOverview) return "overview";
  if (stopIndex <= 1) return "hook";
  if (stopIndex >= totalStops - 1) return "payoff";
  return stopIndex % 2 === 0 ? "reveal" : "contrast";
}

export function resolvePresetRouteVoice(route: PresetNarrationRouteInput): ResolvedRouteVoice {
  return resolvePresetRouteVoiceForPersona(route);
}

export function resolvePresetRouteVoiceForPersona(
  route: PresetNarrationRouteInput,
  personaOverride?: PresetPersona
): ResolvedRouteVoice {
  const basePersona = personaOverride ?? route.voice?.basePersona ?? toPresetPersona(route.defaultPersona);
  const explicitVoice = route.voice;
  const displayName =
    toNullableTrimmed(explicitVoice?.displayName) ||
    toNullableTrimmed(route.storyBy) ||
    PERSONA_DISPLAY_NAME[basePersona];
  const tone = normalizeStringArray(explicitVoice?.tone);
  const bannedPatterns = normalizeStringArray(explicitVoice?.bannedPatterns);
  const openerFamilies = normalizeStringArray(explicitVoice?.openerFamilies);

  return {
    archetypeId: toNullableTrimmed(explicitVoice?.archetypeId) || `${basePersona}-default`,
    displayName,
    basePersona,
    ttsVoice: explicitVoice?.ttsVoice ?? VOICE_BY_PERSONA[basePersona],
    tone: tone.length > 0 ? tone : [...PERSONA_TONE[basePersona]],
    storyLens:
      toNullableTrimmed(explicitVoice?.storyLens) ||
      toNullableTrimmed(route.narratorGuidance) ||
      PERSONA_STORY_LENS[basePersona],
    transitionStyle:
      toNullableTrimmed(explicitVoice?.transitionStyle) ||
      PERSONA_TRANSITION_STYLE[basePersona],
    bannedPatterns:
      bannedPatterns.length > 0
        ? [...PERSONA_BANNED_PATTERNS[basePersona], ...bannedPatterns]
        : [...PERSONA_BANNED_PATTERNS[basePersona]],
    openerFamilies:
      openerFamilies.length > 0 ? openerFamilies : [...PERSONA_OPENERS[basePersona]],
  };
}

export function resolvePresetStopBrief(
  route: PresetNarrationRouteInput,
  stop: PresetNarrationStopInput,
  stopIndex: number,
  totalStops: number,
  personaOverride?: PresetPersona
): ResolvedStopBrief {
  const narration = stop.narration ?? null;
  const contentPriority = toContentPriority(
    narration?.contentPriority ?? stop.contentPriority ?? route.contentPriority ?? null
  );
  const routeVoice = resolvePresetRouteVoiceForPersona(route, personaOverride);
  const beat = narration?.beat ?? inferPresetStopBeat(stopIndex, totalStops, Boolean(stop.isOverview));
  const factBullets = normalizeStringArray(narration?.factBullets ?? stop.factBullets ?? null);
  const mustMention = normalizeStringArray(narration?.mustMention ?? stop.mustMention ?? null);
  const sensoryTargets = normalizeStringArray(narration?.sensoryTargets ?? null);
  const openerFamily = pickRotatingValue(routeVoice.openerFamilies, stopIndex, PERSONA_OPENERS[routeVoice.basePersona][0]!);

  return {
    beat,
    angle: toNullableTrimmed(narration?.angle ?? stop.narratorGuidance ?? null),
    factBullets,
    mustMention,
    sensoryTargets,
    contentPriority,
    openerFamily,
  };
}

export function attachPresetStopNarration<T extends Omit<PresetNarrationStopInput, "narration">>(
  builtStops: T[],
  routeStops: Array<Pick<PresetNarrationStopInput, "id" | "narration">>
): Array<PresetNarrationStopWithNarration<T>> {
  const narrationByStopId = new Map<string, PresetStopNarrationSeed | null>();
  for (const stop of routeStops) {
    narrationByStopId.set(stop.id, stop.narration ?? null);
  }
  return builtStops.map((stop) => ({
    ...stop,
    narration: narrationByStopId.get(stop.id) ?? null,
  }));
}

export function buildPresetPrompt(
  route: PresetNarrationRouteInput,
  stop: PresetNarrationStopInput,
  city: string,
  stopIndex: number,
  totalStops: number,
  personaOverride?: PresetPersona
) {
  const routeVoice = resolvePresetRouteVoiceForPersona(route, personaOverride);
  const stopBrief = resolvePresetStopBrief(route, stop, stopIndex, totalStops, personaOverride);
  const target = lengthTarget(routeVoice.basePersona);
  const factsFirst = stopBrief.factBullets.length > 0 || stopBrief.contentPriority === "history_first";

  const systemPrompt = [
    "You write spoken audio tour narration for curated preset routes.",
    `Narrator identity: ${routeVoice.displayName}.`,
    `Base audience/persona: ${routeVoice.basePersona}.`,
    `Route archetype: ${routeVoice.archetypeId}.`,
    `Story lens: ${routeVoice.storyLens}.`,
    "Keep the writing natural aloud and densely specific.",
    "Facts outrank atmosphere whenever facts are provided.",
    "Do not let the route voice drift between stops.",
  ].join(" ");

  const userPromptLines = [
    `City: ${city}`,
    `Route title: ${route.title}`,
    `Route description: ${route.description}`,
    `Tour length: ${route.durationMinutes || 30} minutes`,
    `Stop ${stopIndex + 1} of ${totalStops}: ${stop.title}`,
    `Stop beat: ${stopBrief.beat}`,
    `Opener family: ${stopBrief.openerFamily}`,
    `Opener instruction: ${openerInstruction(stopBrief.openerFamily, stopBrief.beat)}`,
    `Transition instruction: ${transitionInstruction(routeVoice.transitionStyle, stopIndex, totalStops, Boolean(stop.isOverview))}`,
    `Target spoken duration: ${target.durationSeconds} seconds`,
    "Route voice:",
    `- Display name: ${routeVoice.displayName}`,
    `- Tone: ${routeVoice.tone.join(", ")}`,
    `- Story lens: ${routeVoice.storyLens}`,
  ];

  if (stopBrief.angle) {
    userPromptLines.push(`Stop angle: ${stopBrief.angle}`);
  }
  if (stopBrief.sensoryTargets.length > 0) {
    userPromptLines.push("Sensory targets:");
    userPromptLines.push(...stopBrief.sensoryTargets.map((line) => `- ${line}`));
  }
  if (stopBrief.factBullets.length > 0) {
    userPromptLines.push("Required fact beats:");
    userPromptLines.push(...stopBrief.factBullets.map((line) => `- ${line}`));
  }
  if (stopBrief.mustMention.length > 0) {
    userPromptLines.push("Exact names that must appear verbatim:");
    userPromptLines.push(...stopBrief.mustMention.map((line) => `- ${line}`));
  }

  userPromptLines.push("Disallowed patterns:");
  userPromptLines.push(...routeVoice.bannedPatterns.map((line) => `- ${line}`));
  userPromptLines.push("Requirements:");
  userPromptLines.push(`- ${target.sentenceRange} sentences.`);
  userPromptLines.push(`- ${target.wordRange} words total.`);
  userPromptLines.push("- Mention the stop name once naturally.");
  userPromptLines.push("- End with forward motion unless this is the final stop.");
  userPromptLines.push("- Do not use placeholders, brackets, or stage directions.");
  userPromptLines.push("- Output plain text only.");
  if (factsFirst) {
    userPromptLines.push("- Move into concrete facts within the first 1-2 sentences.");
    userPromptLines.push("- Keep scene-setting brief and subordinate to real facts.");
    userPromptLines.push(
      `- Include at least ${Math.min(2, stopBrief.factBullets.length || 2)} concrete fact beats in clear language.`
    );
  } else {
    userPromptLines.push("- Use specific physical details instead of generic atmosphere.");
  }
  if (stopBrief.mustMention.length > 0) {
    userPromptLines.push(`- Use every exact name listed above at least once if it is relevant to the stop.`);
    userPromptLines.push("- Do not replace exact names with generic labels.");
  }

  return {
    routeVoice,
    stopBrief,
    systemPrompt,
    userPrompt: userPromptLines.join("\n"),
  };
}

export async function generatePresetScriptWithOpenAI(
  apiKey: string,
  city: string,
  route: PresetNarrationRouteInput,
  stop: PresetNarrationStopInput,
  stopIndex: number,
  totalStops: number,
  personaOverride?: PresetPersona
) {
  const prompt = buildPresetPrompt(route, stop, city, stopIndex, totalStops, personaOverride);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: prompt.userPrompt },
      ],
      temperature: 0.65,
      max_tokens: 560,
    }),
  });

  if (!response.ok) {
    throw new Error("OpenAI preset script generation failed");
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || "";
}
