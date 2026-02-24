import { createClient } from "@supabase/supabase-js";
import { historianPersonaPrompt } from "@/lib/personas/historian";
import { mainCharacterPersonaPrompt } from "@/lib/personas/mainCharacter";

export type Persona = "adult" | "preteen";
export type StopInput = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
};

const VOICE_BY_PERSONA: Record<Persona, string> = {
  adult: "alloy",
  preteen: "nova",
};

const PERSONA_PROMPTS = {
  adult: historianPersonaPrompt,
  preteen: mainCharacterPersonaPrompt,
} as const;

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
    `Stop ${stopIndex + 1} of ${totalStops}: ${stop.title}`,
    "Style guidelines:",
    ...personaPrompt.styleGuidelines.map((line) => `- ${line}`),
    "Disallowed patterns:",
    ...personaPrompt.bannedPatterns.map((line) => `- ${line}`),
    "Requirements:",
    "- 3 to 4 sentences.",
    "- 65 to 95 words total.",
    "- Mention the stop name once naturally.",
    "- Include one specific sensory detail.",
    "- End with a short transition to keep moving.",
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
      max_tokens: 240,
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
    const personaPrompt = historianPersonaPrompt;
    return [
      personaPrompt.fallbackTemplate.line1(stop.title, city),
      personaPrompt.fallbackTemplate.line2,
      personaPrompt.fallbackTemplate.line3,
      personaPrompt.fallbackTemplate.line4(index + 2),
    ].join(" ");
  }
  const personaPrompt = mainCharacterPersonaPrompt;
  return [
    personaPrompt.fallbackTemplate.line1(stop.title),
    personaPrompt.fallbackTemplate.line2,
    personaPrompt.fallbackTemplate.line3(city),
    personaPrompt.fallbackTemplate.line4(index + 2),
  ].join(" ");
}
