import { NextResponse } from "next/server.js";
import {
  generateScriptWithOpenAI,
  toNullableTrimmed,
  type StopInput,
} from "@/lib/mixGeneration";
import { resolveGooglePlaceDraftPersona } from "@/lib/socialComposer";

type Body = {
  city?: string | null;
  transportMode?: string | null;
  lengthMinutes?: number | null;
  narratorGuidance?: string | null;
  stop?: Pick<StopInput, "id" | "title" | "lat" | "lng" | "image" | "googlePlaceId"> | null;
  stopIndex?: number | null;
  totalStops?: number | null;
};

function normalizeStop(value: Body["stop"]) {
  if (!value) return null;
  const id = toNullableTrimmed(value.id);
  const title = toNullableTrimmed(value.title);
  const image = toNullableTrimmed(value.image);
  const lat = typeof value.lat === "number" ? value.lat : Number(value.lat);
  const lng = typeof value.lng === "number" ? value.lng : Number(value.lng);
  if (!id || !title || !image || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id,
    title,
    lat,
    lng,
    image,
    googlePlaceId: toNullableTrimmed(value.googlePlaceId) ?? undefined,
  } satisfies StopInput;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const stop = normalizeStop(body.stop);
    if (!stop) {
      return NextResponse.json({ error: "A valid Google place stop is required." }, { status: 400 });
    }

    const apiKey = toNullableTrimmed(process.env.OPENAI_API_KEY);
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY is required." }, { status: 500 });
    }

    const narratorGuidance = toNullableTrimmed(body.narratorGuidance);
    const persona = resolveGooglePlaceDraftPersona(narratorGuidance);
    const city = toNullableTrimmed(body.city) || "nearby";
    const transportMode = toNullableTrimmed(body.transportMode) || "walk";
    const lengthMinutes =
      typeof body.lengthMinutes === "number" && Number.isFinite(body.lengthMinutes)
        ? body.lengthMinutes
        : 30;
    const stopIndex =
      typeof body.stopIndex === "number" && Number.isFinite(body.stopIndex)
        ? Math.max(0, Math.trunc(body.stopIndex))
        : 0;
    const totalStops =
      typeof body.totalStops === "number" && Number.isFinite(body.totalStops)
        ? Math.max(1, Math.trunc(body.totalStops))
        : 1;

    const script = toNullableTrimmed(
      await generateScriptWithOpenAI(
        apiKey,
        city,
        transportMode,
        lengthMinutes,
        persona,
        stop,
        stopIndex,
        totalStops,
        narratorGuidance
      )
    );

    if (!script) {
      return NextResponse.json({ error: "Generated script was empty." }, { status: 500 });
    }

    return NextResponse.json({ script, persona });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate Google place script" },
      { status: 500 }
    );
  }
}
