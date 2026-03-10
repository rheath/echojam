import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById, type Persona } from "@/app/content/salemRoutes";
import { ensureCanonicalStopForPreset, upsertRouteStopMapping } from "@/lib/canonicalStops";
import {
  generateScriptWithOpenAI,
  getSwitchConfig,
  shouldRegenerateScript,
  toNullableTrimmed,
} from "@/lib/mixGeneration";
import { buildPresetStopsWithOverview, normalizePresetCity } from "@/lib/presetOverview";
import {
  getPresetRouteStopAsset,
  mergePresetNarratorGuidance,
  upsertPresetRouteStopAsset,
} from "@/lib/presetRouteAssets";

type Body = {
  routeId: string;
  stopId: string;
  persona: Persona;
  city?: "salem" | "boston" | "concord" | "nyc";
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (body.persona === "custom") {
      return NextResponse.json({ error: "Custom narrator is only available for custom tours." }, { status: 400 });
    }
    const route = getRouteById(body.routeId);
    if (!route) return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });
    const city = route.city ?? normalizePresetCity(body.city);
    const stops = buildPresetStopsWithOverview(route.stops, city, route.contentPriority);
    const stopIndex = stops.findIndex((s) => s.id === body.stopId);
    if (stopIndex < 0) return NextResponse.json({ error: "Unknown stop for preset route" }, { status: 404 });

    const stop = stops[stopIndex];

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is required." }, { status: 500 });

    const admin = getAdmin();
    const canonical = await ensureCanonicalStopForPreset(admin, city, route.id, {
      id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: stop.image,
    });
    await upsertRouteStopMapping(admin, "preset", route.id, stop.id, canonical.id, stopIndex);

    const switchConfig = await getSwitchConfig();
    const forceScript = shouldRegenerateScript(switchConfig.mode);

    const current = await getPresetRouteStopAsset(admin, route.id, stop.id, body.persona);

    const existingScript = toNullableTrimmed(current?.script);
    if (existingScript && !forceScript) {
      return NextResponse.json({ script: existingScript, reused: true });
    }

    const generated = await generateScriptWithOpenAI(
      apiKey,
      city,
      "walk",
      route.durationMinutes || 30,
      body.persona,
      {
        id: stop.id,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        image: stop.image,
        mustMention: stop.mustMention ?? null,
        factBullets: stop.factBullets ?? null,
        contentPriority: stop.contentPriority ?? route.contentPriority ?? null,
      },
      stopIndex,
      stops.length,
      mergePresetNarratorGuidance(route.narratorGuidance, stop.narratorGuidance)
    );

    const script = toNullableTrimmed(generated);
    if (!script) return NextResponse.json({ error: "Generated script was empty" }, { status: 500 });

    await upsertPresetRouteStopAsset(admin, {
      preset_route_id: route.id,
      stop_id: stop.id,
      persona: body.persona,
      script,
      audio_url: current?.audio_url ?? null,
      status: "ready",
      error: null,
    });

    return NextResponse.json({ script, reused: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate preset script" },
      { status: 500 }
    );
  }
}
