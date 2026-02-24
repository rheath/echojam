import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type Persona = "adult" | "preteen";
type StopInput = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
};

type Body = {
  city: string;
  transportMode: "walk" | "drive";
  lengthMinutes: number;
  persona: Persona;
  stops: StopInput[];
};

const VOICE_BY_PERSONA: Record<Persona, string> = {
  adult: "alloy",
  preteen: "nova",
};

async function generateScriptWithOpenAI(
  apiKey: string,
  city: string,
  transportMode: string,
  lengthMinutes: number,
  persona: Persona,
  stop: StopInput
) {
  const personaLabel = persona === "adult" ? "AI Historian" : "AI Main Character";
  const prompt = [
    `You are ${personaLabel}.`,
    `City: ${city}.`,
    `Transportation: ${transportMode}.`,
    `Tour duration target: ${lengthMinutes} minutes total.`,
    `Write 2-3 sentences for stop "${stop.title}".`,
    "Keep it vivid, concise, and suitable for audio narration.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 180,
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

async function synthesizeSpeechWithOpenAI(apiKey: string, persona: Persona, text: string) {
  // Try latest first; fall back to tts-1 for compatibility.
  const attempts = [
    { model: "gpt-4o-mini-tts", voice: VOICE_BY_PERSONA[persona] },
    { model: "tts-1", voice: VOICE_BY_PERSONA[persona] },
  ];

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

    if (!response.ok) continue;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > 0) return new Uint8Array(arrayBuffer);
  }

  throw new Error("OpenAI TTS generation failed");
}

async function uploadNarrationAudio(
  audioBytes: Uint8Array,
  jamLikeId: string,
  persona: Persona,
  stopId: string
) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_AUDIO_BUCKET || "narrations";

  if (url && serviceRole) {
    const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
    const path = `mixes/${jamLikeId}/${persona}/${stopId}.mp3`;
    const { error } = await admin.storage.from(bucket).upload(path, audioBytes, {
      contentType: "audio/mpeg",
      upsert: true,
    });
    if (!error) {
      const { data } = admin.storage.from(bucket).getPublicUrl(path);
      if (data?.publicUrl) return data.publicUrl;
    }
  }

  // Fallback: embedded audio data URL so flow works even without storage service-role configuration.
  const base64 = Buffer.from(audioBytes).toString("base64");
  return `data:audio/mpeg;base64,${base64}`;
}

function fallbackScript(city: string, persona: Persona, stop: StopInput, index: number) {
  const voice = persona === "adult" ? "AI Historian" : "AI Main Character";
  return `${voice} here. Stop ${index + 1} is ${stop.title} in ${city}. Notice one detail around you and imagine how this place connects to the city story.`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body?.stops?.length) {
      return NextResponse.json({ error: "No stops provided" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY is required for AI narration generation." }, { status: 500 });
    }
    const personas: Persona[] = ["adult", "preteen"];
    const narrations: Record<Persona, Array<{ stopId: string; script: string; audioUrl: string }>> = {
      adult: [],
      preteen: [],
    };
    const jamLikeId = `mix-${Date.now()}`;

    for (const persona of personas) {
      for (let i = 0; i < body.stops.length; i += 1) {
        const stop = body.stops[i];
        let script = fallbackScript(body.city, persona, stop, i);
        try {
          const generated = await generateScriptWithOpenAI(
            apiKey,
            body.city,
            body.transportMode,
            body.lengthMinutes,
            persona,
            stop
          );
          if (generated) script = generated;
        } catch {
          // fallback script is used
        }

        let audioUrl = persona === "adult" ? "/audio/adult-01.mp3" : "/audio/kid-01.mp3";
        try {
          const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, persona, script);
          audioUrl = await uploadNarrationAudio(audioBytes, jamLikeId, persona, stop.id);
        } catch {
          // keep placeholder audio as fallback
        }

        narrations[persona].push({
          stopId: stop.id,
          script,
          audioUrl,
        });
      }
    }

    return NextResponse.json({ narrations });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown generation error" },
      { status: 500 }
    );
  }
}
