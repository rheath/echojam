import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Persona, PresetContentPriority } from "@/app/content/salemRoutes";
import {
  dedupeMixedRouteLeadIns,
  describeMixedRouteOpenerFamily,
  pickMixedRouteOpenerFamily,
  type MixedRouteOpenerFamily,
} from "@/lib/mixedRouteOpeners";
import {
  buildPlaceGroundingPromptLines,
  type PlaceGrounding,
} from "@/lib/placeGrounding";
import { personaCatalog } from "@/lib/personas/catalog";
import { customNarratorPersonaPrompt } from "@/lib/personas/customNarrator";

export type { FixedPersona, Persona } from "@/app/content/salemRoutes";
export const CUSTOM_NARRATOR_VOICES = ["alloy", "nova", "shimmer", "onyx"] as const;
export type CustomNarratorVoice = (typeof CUSTOM_NARRATOR_VOICES)[number];
export type GenerationMode =
  | "reuse_existing"
  | "force_regenerate_all"
  | "force_regenerate_script"
  | "force_regenerate_audio";

export type SocialSourceProvider = "instagram" | "tiktok";
export type MixedSourceProvider = SocialSourceProvider | "google_places";

export type GenerationSwitch = {
  mode?: GenerationMode;
  replay_audio?: Record<string, Partial<Record<Persona, string>>>;
};

export type StopInput = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  googlePlaceId?: string;
  sourceProvider?: MixedSourceProvider | null;
  sourceKind?: "social_import" | "place_search" | null;
  sourceUrl?: string | null;
  sourceId?: string | null;
  sourceCreatorName?: string | null;
  sourceCreatorUrl?: string | null;
  sourceCreatorAvatarUrl?: string | null;
  prefilledScript?: string | null;
  scriptEditedByUser?: boolean | null;
  narratorGuidance?: string | null;
  mustMention?: string[] | null;
  factBullets?: string[] | null;
  contentPriority?: PresetContentPriority | null;
};

export type EndingStyle = "reflective_close" | "transition";

export type ScriptGenerationOptions = {
  routeContextMode?: "mixed" | null;
  openerFamily?: MixedRouteOpenerFamily | null;
  blockedLeadIns?: string[] | null;
  endingStyle?: EndingStyle | null;
  placeGrounding?: PlaceGrounding | null;
};

const DEFAULT_SWITCH: Required<GenerationSwitch> = {
  mode: "reuse_existing",
  replay_audio: {},
};

const VOICE_BY_PERSONA: Record<Exclude<Persona, "custom">, string> = {
  adult: "alloy",
  preteen: "nova",
  ghost: "alloy",
};

const FIXED_PERSONA_PROMPTS = {
  adult: personaCatalog.adult.prompt,
  preteen: personaCatalog.preteen.prompt,
  ghost: personaCatalog.ghost.prompt,
} as const;

function getPersonaPrompt(persona: Persona) {
  if (persona === "custom") return customNarratorPersonaPrompt;
  return FIXED_PERSONA_PROMPTS[persona];
}

function resolveEndingStyle(value: EndingStyle | null | undefined): EndingStyle {
  return value === "transition" ? "transition" : "reflective_close";
}

function buildEndingRequirements(endingStyle: EndingStyle) {
  if (endingStyle === "transition") {
    return [
      "- End with a transition that carries the listener onward without using a stock phrase.",
    ];
  }

  return [
    "- End with a reflective close tied to this place rather than teasing what comes next.",
    "- Let the final line land on meaning, atmosphere, or one concrete detail the listener can hold onto here.",
    "- Do not mention the next stop, continuing onward, keeping moving, or what comes next.",
  ];
}

function buildEndingDisallowedPatterns(endingStyle: EndingStyle) {
  if (endingStyle !== "reflective_close") return [] as string[];
  return [
    "Do not end with phrases like 'next stop,' 'continue,' 'keep moving,' or 'what comes next.'",
  ];
}

export function toCustomNarratorVoice(value: string | null | undefined): CustomNarratorVoice | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "alloy" || normalized === "nova" || normalized === "shimmer" || normalized === "onyx") {
    return normalized;
  }
  return null;
}

export function selectCustomNarratorVoice(guidance: string): CustomNarratorVoice {
  const normalized = guidance.toLowerCase();
  const scores: Record<CustomNarratorVoice, number> = {
    alloy: 0,
    nova: 0,
    shimmer: 0,
    onyx: 0,
  };

  const applyScore = (voice: CustomNarratorVoice, terms: string[], weight = 1) => {
    for (const term of terms) {
      if (normalized.includes(term)) scores[voice] += weight;
    }
  };

  applyScore("nova", [
    "kid",
    "kids",
    "child",
    "children",
    "fun",
    "playful",
    "energetic",
    "excited",
    "adventure",
    "adventurous",
    "young",
    "8 year",
    "8-year",
    "family friendly",
    "family-friendly",
  ]);
  applyScore("onyx", [
    "spooky",
    "haunting",
    "haunted",
    "eerie",
    "mysterious",
    "mystery",
    "ghost",
    "dark",
    "dramatic",
    "ominous",
    "gothic",
    "whisper",
  ]);
  applyScore("shimmer", [
    "calm",
    "warm",
    "gentle",
    "soft",
    "reflective",
    "soothing",
    "peaceful",
    "quiet",
    "intimate",
    "thoughtful",
    "meditative",
    "comforting",
  ]);

  const ranked: CustomNarratorVoice[] = ["nova", "onyx", "shimmer", "alloy"];
  let bestVoice: CustomNarratorVoice = "alloy";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const voice of ranked) {
    const score = scores[voice];
    if (score > bestScore) {
      bestVoice = voice;
      bestScore = score;
    }
  }
  return bestVoice;
}

function getNarrationVoice(persona: Persona, customVoice?: CustomNarratorVoice | null) {
  if (persona === "custom") return customVoice ?? "alloy";
  return VOICE_BY_PERSONA[persona];
}

const GUIDANCE_REFERENCE_STOPWORDS = new Set([
  "A",
  "An",
  "And",
  "As",
  "At",
  "But",
  "By",
  "Do",
  "For",
  "From",
  "How",
  "If",
  "Imagine",
  "In",
  "Into",
  "It",
  "Its",
  "Like",
  "Make",
  "Now",
  "Of",
  "Or",
  "So",
  "Talk",
  "The",
  "This",
  "To",
  "Turn",
  "With",
]);

export function extractGuidanceReferenceTargets(
  narratorGuidance: string | null | undefined,
  stopTitle?: string | null
) {
  const normalizedNarratorGuidance = toNullableTrimmed(narratorGuidance);
  if (!normalizedNarratorGuidance) return [] as string[];

  const stopTitleParts = new Set(
    (stopTitle || "")
      .split(/[^A-Za-z0-9]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.toLowerCase())
  );

  const seen = new Set<string>();
  const targets: string[] = [];
  const pushTarget = (value: string) => {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(normalized);
  };

  const phraseMatches = normalizedNarratorGuidance.match(/\b(?:[A-Z][a-z]+(?:['’]s)?(?:\s+[A-Z][a-z]+(?:['’]s)?)*)\b/g) ?? [];
  for (const phrase of phraseMatches) {
    const parts = phrase.split(/\s+/).filter(Boolean);
    const meaningfulParts = parts.filter((part) => {
      const stripped = part.replace(/['’]s$/i, "");
      if (!stripped) return false;
      if (GUIDANCE_REFERENCE_STOPWORDS.has(stripped)) return false;
      if (stopTitleParts.has(stripped.toLowerCase())) return false;
      return true;
    });
    if (meaningfulParts.length === 0) continue;
    if (meaningfulParts.length === 1) {
      pushTarget(meaningfulParts[0]!.replace(/['’]s$/i, ""));
      continue;
    }
    pushTarget(meaningfulParts.join(" ").replace(/['’]s\b/gi, ""));
    for (const part of meaningfulParts) {
      pushTarget(part.replace(/['’]s$/i, ""));
    }
  }

  return targets.slice(0, 6);
}

function normalizePromptStringArray(value: string[] | readonly string[] | null | undefined) {
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

export function buildStructuredStopPromptConfig(
  stop: Pick<StopInput, "title" | "mustMention" | "factBullets" | "contentPriority">,
  narratorGuidance?: string | null
) {
  const contentPriority: PresetContentPriority = stop.contentPriority === "history_first" ? "history_first" : "default";
  const factBullets = normalizePromptStringArray(stop.factBullets);
  const explicitMustMention = normalizePromptStringArray(stop.mustMention);
  const fallbackReferenceTargets =
    explicitMustMention.length === 0 ? extractGuidanceReferenceTargets(narratorGuidance, stop.title) : [];
  const mustMention = normalizePromptStringArray([...explicitMustMention, ...fallbackReferenceTargets]);

  const extraStyleGuidelines =
    contentPriority === "history_first"
      ? [
          "Move into the landmark's real NYC-to-comics connection within the first two sentences.",
          "Let concrete comic-book history and exact named references carry the stop more than generic adventure atmosphere.",
          "Keep imaginative framing light and anchored to the factual material.",
        ]
      : [];

  const promptSections: string[] = [];
  if (contentPriority === "history_first") {
    promptSections.push(
      "Content priority: history-first. Real comic-book history and NYC influence come before cinematic scene-setting."
    );
  }
  if (factBullets.length > 0) {
    promptSections.push("Required fact beats:");
    promptSections.push(...factBullets.map((fact) => `- ${fact}`));
  }
  if (mustMention.length > 0) {
    promptSections.push("Exact names to preserve verbatim when relevant:");
    promptSections.push(...mustMention.map((name) => `- ${name}`));
  }

  const extraRequirements: string[] = [];
  if (contentPriority === "history_first") {
    extraRequirements.push("- Move from setup into concrete comic-book history within the first two sentences.");
    extraRequirements.push("- Keep sensory/setup language brief; spend most of the script on real NYC comic-book history and influence.");
    extraRequirements.push("- Include at least one concrete present-day detail from the scene.");
    if (factBullets.length > 0) {
      extraRequirements.push(
        `- Include at least ${Math.min(2, factBullets.length)} of the required fact beats below in clear, concrete language.`
      );
    }
    if (mustMention.length > 0) {
      extraRequirements.push(`- Mention at least one of these exact names verbatim: ${mustMention.join(", ")}.`);
      if (mustMention.length > 1) {
        extraRequirements.push("- Prefer mentioning two exact names if it stays natural.");
      }
      extraRequirements.push("- Do not replace exact names with generic phrases or broad superhero language.");
    }
    extraRequirements.push("- Treat narrator guidance as tone and framing only; the structured facts and exact names are the primary content.");
  } else {
    extraRequirements.push("- Include at least two specific sensory details.");
  }

  return {
    contentPriority,
    factBullets,
    mustMention,
    extraStyleGuidelines,
    promptSections,
    extraRequirements,
  };
}

export function toNullableTrimmed(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function toNullableAudioUrl(value: string | null | undefined): string | null {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return null;
  if (normalized.toLowerCase().startsWith("data:")) return null;
  return normalized;
}

export function isUsableGeneratedAudioUrl(url: string | null | undefined) {
  const normalized = toNullableAudioUrl(url);
  if (!normalized) return false;
  return !normalized.startsWith("/audio/");
}

export function shouldRegenerateScript(mode: GenerationMode) {
  return mode === "force_regenerate_all" || mode === "force_regenerate_script";
}

export function shouldRegenerateAudio(mode: GenerationMode) {
  return mode === "force_regenerate_all" || mode === "force_regenerate_audio";
}

export async function getSwitchConfig(): Promise<Required<GenerationSwitch>> {
  const fileName = process.env.MIX_GENERATION_SWITCH_FILE || "mix-generation-switch.json";
  const filePath = path.join(process.cwd(), fileName);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as GenerationSwitch;
    return {
      mode: parsed.mode || DEFAULT_SWITCH.mode,
      replay_audio: parsed.replay_audio || {},
    };
  } catch {
    return DEFAULT_SWITCH;
  }
}

export async function generateScriptWithOpenAI(
  apiKey: string,
  city: string,
  transportMode: string,
  lengthMinutes: number,
  persona: Persona,
  stop: StopInput,
  stopIndex: number,
  totalStops: number,
  narratorGuidance?: string | null,
  options?: ScriptGenerationOptions | null
) {
  const personaPrompt = getPersonaPrompt(persona);
  const normalizedNarratorGuidance = toNullableTrimmed(narratorGuidance);
  const structuredPromptConfig = buildStructuredStopPromptConfig(stop, normalizedNarratorGuidance);
  const endingStyle = resolveEndingStyle(options?.endingStyle);
  const placeGrounding = options?.placeGrounding ?? null;
  const routeContextMode = options?.routeContextMode === "mixed" ? "mixed" : null;
  const openerFamily =
    routeContextMode === "mixed"
      ? options?.openerFamily ?? pickMixedRouteOpenerFamily(persona, stopIndex)
      : null;
  const blockedLeadIns =
    routeContextMode === "mixed"
      ? dedupeMixedRouteLeadIns(options?.blockedLeadIns ?? [])
      : [];
  if (persona === "custom" && !normalizedNarratorGuidance) {
    throw new Error("Narrator guidance is required for custom narrator generation.");
  }

  const effectiveStyleGuidelines =
    structuredPromptConfig.contentPriority === "history_first"
      ? [
          ...structuredPromptConfig.extraStyleGuidelines,
          ...personaPrompt.styleGuidelines.filter(
            (line) =>
              line !== "Open with a vivid sensory detail that makes the listener feel like the adventure has already started." &&
              line !== "Speak directly to the listener in short, natural sentences with strong rhythm." &&
              line !== "Structure each stop as a mini adventure: Hook → Clue → Real-world fact → Why it matters → Forward momentum." &&
              line !== "Include exactly one safe and simple 'Explorer Move' per stop (look up, count something, spot a symbol, notice a sound)." &&
              line !== "Blend one grounded historical or cultural fact into the story naturally. Facts should feel like discoveries."
          ),
        ]
      : personaPrompt.styleGuidelines;

  const systemPrompt = [
    ...personaPrompt.system,
    "Write natural spoken narration for one tour stop.",
    ...(structuredPromptConfig.contentPriority === "history_first"
      ? ["For this stop, factual comic-book history and exact named references outrank cinematic scene-setting."]
      : []),
  ].join(" ");

  const userPrompt = [
    `City: ${city}`,
    `Transport: ${transportMode}`,
    `Tour length: ${lengthMinutes} minutes`,
    `Narrator persona: ${personaPrompt.name}`,
    ...(normalizedNarratorGuidance ? [`Narrator guidance: ${normalizedNarratorGuidance}`] : []),
    `Target spoken duration for this stop: ${personaPrompt.lengthTarget.durationSeconds} seconds`,
    `Stop ${stopIndex + 1} of ${totalStops}: ${stop.title}`,
    ...buildPlaceGroundingPromptLines(placeGrounding),
    ...structuredPromptConfig.promptSections,
    ...(routeContextMode === "mixed" && openerFamily
      ? [
          "Mixed-route opener context:",
          `- Opener family: ${openerFamily}. ${describeMixedRouteOpenerFamily(openerFamily)}`,
          "- This stop is part of a mixed-source route, so its opening should feel distinct from prior stops.",
          "- Do not begin with 'Welcome to'.",
          ...(blockedLeadIns.length > 0
            ? [
                `- Do not reuse any of these opening lead-ins: ${blockedLeadIns
                  .map((leadIn) => `"${leadIn}"`)
                  .join(", ")}.`,
              ]
            : []),
        ]
      : []),
    "Style guidelines:",
    ...effectiveStyleGuidelines.map((line) => `- ${line}`),
    "Disallowed patterns:",
    ...personaPrompt.bannedPatterns.map((line) => `- ${line}`),
    ...buildEndingDisallowedPatterns(endingStyle).map((line) => `- ${line}`),
    ...(placeGrounding
      ? [
          "- Do not mention raw coordinates, latitude/longitude, or map pins.",
          "- Do not mechanically recite the full street address unless the source material naturally depends on it.",
        ]
      : []),
    "Requirements:",
    `- ${personaPrompt.lengthTarget.sentenceRange} sentences.`,
    `- ${personaPrompt.lengthTarget.wordRange} words total.`,
    "- Mention the stop name once naturally.",
    "- Include one memorable hook line.",
    ...buildEndingRequirements(endingStyle),
    ...structuredPromptConfig.extraRequirements,
    ...(normalizedNarratorGuidance
      ? [
          "- Preserve specific names from narrator guidance rather than generalizing them.",
          "- If narrator guidance names characters, places, worlds, or franchises, mention at least one exact name verbatim when it fits naturally.",
          "- Do not replace named references with vague substitutes like 'superheroes' or 'comic-book cities'.",
        ]
      : []),
    ...(structuredPromptConfig.mustMention.length > 0 && structuredPromptConfig.contentPriority !== "history_first"
      ? [
          `- Include at least one of these exact references verbatim if it fits naturally: ${structuredPromptConfig.mustMention.join(", ")}.`,
        ]
      : []),
    ...(routeContextMode === "mixed"
      ? [
          "- Avoid generic tour-guide openings and repeated lead-ins from earlier stops.",
          "- Make the opener feel specific to this stop instead of introducing the place with a stock phrase.",
        ]
      : []),
    ...(placeGrounding
      ? [
          "- Make sure the place framing matches the confirmed neighborhood, city, and venue context when those are provided.",
        ]
      : []),
    "- Do not use placeholders, brackets, or stage directions.",
    "- Output plain text only.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 520,
    }),
  });

  if (!response.ok) {
    throw new Error("OpenAI script generation failed");
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || "";
}

export async function rewriteScriptOpenerWithOpenAI(
  apiKey: string,
  city: string,
  transportMode: string,
  lengthMinutes: number,
  persona: Persona,
  stop: Pick<StopInput, "id" | "title" | "lat" | "lng" | "image" | "googlePlaceId">,
  originalScript: string,
  narratorGuidance?: string | null,
  options?: ScriptGenerationOptions | null
) {
  const personaPrompt = getPersonaPrompt(persona);
  const normalizedNarratorGuidance = toNullableTrimmed(narratorGuidance);
  const routeContextMode = options?.routeContextMode === "mixed" ? "mixed" : null;
  const openerFamily =
    routeContextMode === "mixed" ? options?.openerFamily ?? pickMixedRouteOpenerFamily(persona, 0) : null;
  const blockedLeadIns =
    routeContextMode === "mixed"
      ? dedupeMixedRouteLeadIns(options?.blockedLeadIns ?? [])
      : [];
  if (persona === "custom" && !normalizedNarratorGuidance) {
    throw new Error("Narrator guidance is required for custom narrator generation.");
  }

  const systemPrompt = [
    ...personaPrompt.system,
    "You revise existing audio tour scripts with a light touch.",
    "Preserve the original facts, named references, and ending.",
    "Rewrite only the opening one or two sentences unless a tiny connective edit is required.",
  ].join(" ");

  const userPrompt = [
    `City: ${city}`,
    `Transport: ${transportMode}`,
    `Tour length: ${lengthMinutes} minutes`,
    `Narrator persona: ${personaPrompt.name}`,
    ...(normalizedNarratorGuidance ? [`Narrator guidance: ${normalizedNarratorGuidance}`] : []),
    `Stop: ${stop.title}`,
    ...(routeContextMode === "mixed" && openerFamily
      ? [
          "Mixed-route opener context:",
          `- Opener family: ${openerFamily}. ${describeMixedRouteOpenerFamily(openerFamily)}`,
          "- Do not begin with 'Welcome to'.",
          ...(blockedLeadIns.length > 0
            ? [
                `- Do not reuse any of these opening lead-ins: ${blockedLeadIns
                  .map((leadIn) => `"${leadIn}"`)
                  .join(", ")}.`,
              ]
            : []),
        ]
      : []),
    "Rewrite requirements:",
    "- Keep the body content, factual claims, named references, and ending aligned with the original script.",
    "- Rewrite only the opening one or two sentences unless a tiny connective edit is required.",
    "- Keep the total length and spoken rhythm close to the original.",
    "- Return the full revised script as plain text only.",
    "",
    "Original script:",
    originalScript,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 520,
    }),
  });

  if (!response.ok) {
    throw new Error("OpenAI opener rewrite failed");
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || "";
}

export async function synthesizeSpeechWithOpenAI(
  apiKey: string,
  persona: Persona,
  text: string,
  customVoice?: CustomNarratorVoice | null
) {
  const voice = getNarrationVoice(persona, customVoice);
  const attempts = [
    { model: "gpt-4o-mini-tts", voice },
    { model: "tts-1", voice },
  ];
  const failures: string[] = [];

  for (const attempt of attempts) {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: attempt.model,
        voice: attempt.voice,
        input: text,
        format: "mp3",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      failures.push(`${attempt.model}/${attempt.voice}: ${response.status}${body ? ` ${body}` : ""}`);
      continue;
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > 0) return new Uint8Array(arrayBuffer);
    failures.push(`${attempt.model}/${attempt.voice}: empty audio response`);
  }

  throw new Error(`OpenAI TTS generation failed (${failures.join(" | ")})`);
}

export async function uploadNarrationAudio(audioBytes: Uint8Array, routeId: string, persona: Persona, stopId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_AUDIO_BUCKET || "narrations";
  const cacheControl = process.env.SUPABASE_AUDIO_CACHE_SECONDS || "31536000";
  const version = createHash("sha1").update(audioBytes).digest("hex").slice(0, 12);
  const safeRouteId = routeId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "route";
  const safeStopId = stopId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "stop";

  if (!url || !serviceRole) {
    throw new Error("Missing storage configuration for narration upload.");
  }

  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
  const path = `mixes/${safeRouteId}/${persona}/${safeStopId}.mp3`;

  const { data: buckets, error: listBucketsError } = await admin.storage.listBuckets();
  if (listBucketsError) {
    throw new Error(`Narration upload failed: could not list storage buckets (${listBucketsError.message}).`);
  }
  const bucketExists = (buckets ?? []).some((item) => item.name === bucket);
  if (!bucketExists) {
    const { error: createBucketError } = await admin.storage.createBucket(bucket, { public: true });
    if (createBucketError && !createBucketError.message.toLowerCase().includes("already exists")) {
      throw new Error(
        `Narration upload failed: Supabase storage bucket "${bucket}" was not found and could not be created (${createBucketError.message}).`
      );
    }
  }

  const { error } = await admin.storage.from(bucket).upload(path, audioBytes, {
    contentType: "audio/mpeg",
    cacheControl,
    upsert: true,
  });
  if (error) {
    if (error.message.toLowerCase().includes("bucket not found")) {
      throw new Error(
        `Narration upload failed: Supabase storage bucket "${bucket}" was not found. ` +
          "Create the bucket or set SUPABASE_AUDIO_BUCKET to an existing bucket name."
      );
    }
    throw new Error(`Narration upload failed: ${error.message}`);
  }

  const { data } = admin.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error("Narration upload succeeded but public URL was unavailable.");
  }
  const sep = data.publicUrl.includes("?") ? "&" : "?";
  return `${data.publicUrl}${sep}v=${version}`;
}

export function fallbackScript(city: string, persona: Persona, stop: StopInput, index: number) {
  if (persona === "adult") {
    const personaPrompt = FIXED_PERSONA_PROMPTS.adult;
    return [
      personaPrompt.fallbackTemplate.line1(stop.title, city),
      personaPrompt.fallbackTemplate.line2,
      personaPrompt.fallbackTemplate.line3,
      personaPrompt.fallbackTemplate.line4(index + 2),
    ].join(" ");
  }
  if (persona === "preteen") {
    const personaPrompt = FIXED_PERSONA_PROMPTS.preteen;
    return [
      personaPrompt.fallbackTemplate.line1(stop.title),
      personaPrompt.fallbackTemplate.line2,
      personaPrompt.fallbackTemplate.line3(city),
      personaPrompt.fallbackTemplate.line4,
    ].join(" ");
  }
  if (persona === "custom") {
    return [
      `You are at ${stop.title}, one of the places that gives ${city} its character.`,
      "Take in the details around you and let this stop settle into its own texture and rhythm.",
      "There is something worth noticing here that lingers after the words are gone.",
    ].join(" ");
  }

  const ghostPrompt = FIXED_PERSONA_PROMPTS.ghost;
  return [
    ghostPrompt.fallbackTemplate.line1(stop.title, city),
    ghostPrompt.fallbackTemplate.line2,
    ghostPrompt.fallbackTemplate.line3,
    ghostPrompt.fallbackTemplate.line4,
  ].join(" ");
}
