import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { personaCatalog } from "@/lib/personas/catalog";

export type Persona = "adult" | "preteen";
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
};

const DEFAULT_SWITCH: Required<GenerationSwitch> = {
  mode: "reuse_existing",
  replay_audio: {},
};

const VOICE_BY_PERSONA: Record<Persona, string> = {
  adult: "alloy",
  preteen: "nova",
};

const PERSONA_PROMPTS = {
  adult: personaCatalog.adult.prompt,
  preteen: personaCatalog.preteen.prompt,
} as const;

export function toNullableTrimmed(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function isUsableGeneratedAudioUrl(url: string | null | undefined) {
  const normalized = toNullableTrimmed(url);
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
  totalStops: number
) {
  const personaPrompt = PERSONA_PROMPTS[persona];
  const systemPrompt = [
    ...personaPrompt.system,
    "Write natural spoken narration for one tour stop.",
  ].join(" ");

  const userPrompt = [
    `City: ${city}`,
    `Transport: ${transportMode}`,
    `Tour length: ${lengthMinutes} minutes`,
    `Narrator persona: ${personaPrompt.name}`,
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

export async function synthesizeSpeechWithOpenAI(apiKey: string, persona: Persona, text: string) {
  const attempts = [
    { model: "gpt-4o-mini-tts", voice: VOICE_BY_PERSONA[persona] },
    { model: "tts-1", voice: VOICE_BY_PERSONA[persona] },
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

  if (url && serviceRole) {
    const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
    const path = `mixes/${routeId}/${persona}/${stopId}.mp3`;
    const { error } = await admin.storage.from(bucket).upload(path, audioBytes, {
      contentType: "audio/mpeg",
      upsert: true,
    });
    if (!error) {
      const { data } = admin.storage.from(bucket).getPublicUrl(path);
      if (data?.publicUrl) return data.publicUrl;
    }
  }

  const base64 = Buffer.from(audioBytes).toString("base64");
  return `data:audio/mpeg;base64,${base64}`;
}

export function fallbackScript(city: string, persona: Persona, stop: StopInput, index: number) {
  if (persona === "adult") {
    const personaPrompt = PERSONA_PROMPTS.adult;
    return [
      personaPrompt.fallbackTemplate.line1(stop.title, city),
      personaPrompt.fallbackTemplate.line2,
      personaPrompt.fallbackTemplate.line3,
      personaPrompt.fallbackTemplate.line4(index + 2),
    ].join(" ");
  }
  const personaPrompt = PERSONA_PROMPTS.preteen;
  return [
    personaPrompt.fallbackTemplate.line1(stop.title),
    personaPrompt.fallbackTemplate.line2,
    personaPrompt.fallbackTemplate.line3(city),
    personaPrompt.fallbackTemplate.line4(index + 2),
  ].join(" ");
}
