import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById, type Persona } from "@/app/content/salemRoutes";
import { generateScriptWithOpenAI, getSwitchConfig, shouldRegenerateScript, toNullableTrimmed } from "@/lib/mixGeneration";

type Body = {
  routeId: string;
  stopId: string;
  persona: Persona;
  city?: "salem" | "boston" | "concord";
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
    const route = getRouteById(body.routeId);
    if (!route) return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });
    const stopIndex = route.stops.findIndex((s) => s.id === body.stopId);
    if (stopIndex < 0) return NextResponse.json({ error: "Unknown stop for preset route" }, { status: 404 });
    const stop = route.stops[stopIndex];

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is required." }, { status: 500 });

    const admin = getAdmin();
    const switchConfig = await getSwitchConfig();
    const forceScript = shouldRegenerateScript(switchConfig.mode);

    const { data: current } = await admin
      .from("preset_route_stop_assets")
      .select("script,audio_url,status,error")
      .eq("preset_route_id", body.routeId)
      .eq("stop_id", body.stopId)
      .eq("persona", body.persona)
      .maybeSingle();

    const existingScript = toNullableTrimmed(current?.script);
    if (existingScript && !forceScript) {
      return NextResponse.json({ script: existingScript, reused: true });
    }

    const generated = await generateScriptWithOpenAI(
      apiKey,
      body.city ?? "salem",
      "walk",
      parseInt(route.durationLabel, 10) || 30,
      body.persona,
      {
        id: stop.id,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        image: stop.images[0] ?? "/images/salem/placeholder-01.png",
      },
      stopIndex,
      route.stops.length
    );
    const script = toNullableTrimmed(generated);
    if (!script) return NextResponse.json({ error: "Generated script was empty" }, { status: 500 });

    await admin.from("preset_route_stop_assets").upsert(
      {
        preset_route_id: body.routeId,
        stop_id: body.stopId,
        persona: body.persona,
        script,
        audio_url: toNullableTrimmed(current?.audio_url),
        status: "ready",
        error: null,
      },
      { onConflict: "preset_route_id,stop_id,persona" }
    );

    return NextResponse.json({ script, reused: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate preset script" },
      { status: 500 }
    );
  }
}
