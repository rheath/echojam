import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Persona } from "@/app/content/salemRoutes";
import { ensureCanonicalStopForCustom, upsertRouteStopMapping } from "@/lib/canonicalStops";
import {
  generateScriptWithOpenAI,
  getSwitchConfig,
  shouldRegenerateScript,
  toNullableAudioUrl,
  toNullableTrimmed,
} from "@/lib/mixGeneration";

type Body = {
  routeId: string;
  stopId: string;
  persona: Persona;
  city?: "salem" | "boston" | "concord" | "nyc";
};

const SCRIPT_PATCH_BY_PERSONA = {
  adult: (script: string) => ({ script_adult: script }),
  preteen: (script: string) => ({ script_preteen: script }),
  ghost: (script: string) => ({ script_ghost: script }),
  custom: (script: string) => ({ script_custom: script }),
} as const;

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const admin = getAdmin();

    const { data: route, error: routeErr } = await admin
      .from("custom_routes")
      .select("id,city,length_minutes,transport_mode,narrator_guidance,narrator_default")
      .eq("id", body.routeId)
      .single();
    if (routeErr || !route) return NextResponse.json({ error: routeErr?.message || "Unknown custom route" }, { status: 404 });

    const { data: stop, error: stopErr } = await admin
      .from("custom_route_stops")
      .select("route_id,stop_id,position,title,lat,lng,image_url")
      .eq("route_id", body.routeId)
      .eq("stop_id", body.stopId)
      .single();
    if (stopErr || !stop) return NextResponse.json({ error: stopErr?.message || "Unknown stop for route" }, { status: 404 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is required." }, { status: 500 });

    const city = body.city ?? route.city;
    if (body.persona === "custom") {
      const narratorGuidance = toNullableTrimmed(route.narrator_guidance);
      if (!narratorGuidance) {
        return NextResponse.json({ error: "Narrator guidance is missing for this route." }, { status: 400 });
      }

      const { data: currentStopRow } = await admin
        .from("custom_route_stops")
        .select("script_custom")
        .eq("route_id", body.routeId)
        .eq("stop_id", body.stopId)
        .maybeSingle();

      const switchConfig = await getSwitchConfig();
      const forceScript = shouldRegenerateScript(switchConfig.mode);
      const existingScript = toNullableTrimmed(currentStopRow?.script_custom);
      if (existingScript && !forceScript) {
        return NextResponse.json({ script: existingScript, reused: true });
      }

      const { count: totalStops } = await admin
        .from("custom_route_stops")
        .select("*", { count: "exact", head: true })
        .eq("route_id", body.routeId);

      const generated = await generateScriptWithOpenAI(
        apiKey,
        city,
        route.transport_mode ?? "walk",
        route.length_minutes ?? 30,
        body.persona,
        {
          id: stop.stop_id,
          title: stop.title,
          lat: stop.lat,
          lng: stop.lng,
          image: stop.image_url,
        },
        stop.position ?? 0,
        totalStops ?? 1,
        narratorGuidance,
        { endingStyle: "reflective_close" }
      );

      const script = toNullableTrimmed(generated);
      if (!script) return NextResponse.json({ error: "Generated script was empty" }, { status: 500 });

      const scriptPatch = SCRIPT_PATCH_BY_PERSONA[body.persona](script);
      await admin.from("custom_route_stops").update(scriptPatch).eq("route_id", body.routeId).eq("stop_id", body.stopId);

      return NextResponse.json({ script, reused: false });
    }

    const canonical = await ensureCanonicalStopForCustom(admin, city, {
      id: stop.stop_id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: stop.image_url,
    });
    await upsertRouteStopMapping(admin, "custom", body.routeId, stop.stop_id, canonical.id, stop.position);

    const switchConfig = await getSwitchConfig();
    const forceScript = shouldRegenerateScript(switchConfig.mode);

    const { data: current } = await admin
      .from("canonical_stop_assets")
      .select("script,audio_url,status,error")
      .eq("canonical_stop_id", canonical.id)
      .eq("persona", body.persona)
      .maybeSingle();

    const existingScript = toNullableTrimmed(current?.script);
    if (existingScript && !forceScript) {
      return NextResponse.json({ script: existingScript, reused: true });
    }

    const { count: totalStops } = await admin
      .from("custom_route_stops")
      .select("*", { count: "exact", head: true })
      .eq("route_id", body.routeId);

    const generated = await generateScriptWithOpenAI(
      apiKey,
      city,
      route.transport_mode ?? "walk",
      route.length_minutes ?? 30,
      body.persona,
      {
        id: stop.stop_id,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        image: stop.image_url,
      },
      stop.position ?? 0,
      totalStops ?? 1,
      undefined,
      { endingStyle: "reflective_close" }
    );

    const script = toNullableTrimmed(generated);
    if (!script) return NextResponse.json({ error: "Generated script was empty" }, { status: 500 });

    await admin.from("canonical_stop_assets").upsert(
      {
        canonical_stop_id: canonical.id,
        persona: body.persona,
        script,
        audio_url: toNullableAudioUrl(current?.audio_url),
        status: "ready",
        error: null,
      },
      { onConflict: "canonical_stop_id,persona" }
    );

    const scriptPatch = SCRIPT_PATCH_BY_PERSONA[body.persona](script);
    await admin.from("custom_route_stops").update(scriptPatch).eq("route_id", body.routeId).eq("stop_id", body.stopId);

    return NextResponse.json({ script, reused: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate custom script" },
      { status: 500 }
    );
  }
}
