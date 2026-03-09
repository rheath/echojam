import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Persona } from "@/app/content/salemRoutes";
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
  narratorGuidance?: string | null
) {
  const personaPrompt = getPersonaPrompt(persona);
  const normalizedNarratorGuidance = toNullableTrimmed(narratorGuidance);
  if (persona === "custom" && !normalizedNarratorGuidance) {
    throw new Error("Narrator guidance is required for custom narrator generation.");
  }
  const systemPrompt = [
    ...personaPrompt.system,
    "Write natural spoken narration for one tour stop.",
  ].join(" ");

  const userPrompt = [
    `City: ${city}`,
    `Transport: ${transportMode}`,
    `Tour length: ${lengthMinutes} minutes`,
    `Narrator persona: ${personaPrompt.name}`,
    ...(normalizedNarratorGuidance ? [`Narrator guidance: ${normalizedNarratorGuidance}`] : []),
    `Target spoken duration for this stop: ${personaPrompt.lengthTarget.durationSeconds} seconds`,
    `Stop ${stopIndex + 1} of ${totalStops}: ${stop.title}`,
    "Style guidelines:",
    ...personaPrompt.styleGuidelines.map((line) => `- ${line}`),
    "Disallowed patterns:",
    ...personaPrompt.bannedPatterns.map((line) => `- ${line}`),
    "Requirements:",
    `- ${personaPrompt.lengthTarget.sentenceRange} sentences.`,
    `- ${personaPrompt.lengthTarget.wordRange} words total.`,
    "- Mention the stop name once naturally.",
    "- Include at least two specific sensory details.",
    "- Include one memorable hook line.",
    "- End with a transition to keep moving.",
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
      "Take in the details around you and let this stop set the tone for the rest of the tour.",
      "There is something worth noticing here before we move on.",
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
