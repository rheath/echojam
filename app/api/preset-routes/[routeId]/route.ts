import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById } from "@/app/content/salemRoutes";
import { toNullableTrimmed } from "@/lib/mixGeneration";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(_: Request, ctx: { params: Promise<{ routeId: string }> }) {
  try {
    const { routeId } = await ctx.params;
    const route = getRouteById(routeId);
    if (!route) return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });

    const admin = getAdmin();
    const { data: assets, error: assetsErr } = await admin
      .from("preset_route_stop_assets")
      .select("stop_id,persona,script,audio_url,status,error,updated_at")
      .eq("preset_route_id", routeId);
    if (assetsErr) return NextResponse.json({ error: assetsErr.message }, { status: 500 });

    const { data: latestJob } = await admin
      .from("preset_generation_jobs")
      .select("status")
      .eq("preset_route_id", routeId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const byStop = new Map<
      string,
      {
        script_adult: string | null;
        script_preteen: string | null;
        audio_url_adult: string | null;
        audio_url_preteen: string | null;
      }
    >();

    for (const row of assets ?? []) {
      const stopId = row.stop_id as string;
      const entry = byStop.get(stopId) ?? {
        script_adult: null,
        script_preteen: null,
        audio_url_adult: null,
        audio_url_preteen: null,
      };
      const script = toNullableTrimmed(row.script);
      const audioUrl = toNullableTrimmed(row.audio_url);
      if (row.persona === "adult") {
        entry.script_adult = script;
        entry.audio_url_adult = audioUrl;
      } else {
        entry.script_preteen = script;
        entry.audio_url_preteen = audioUrl;
      }
      byStop.set(stopId, entry);
    }

    const stops = route.stops.map((stop, index) => {
      const assetsForStop = byStop.get(stop.id);
      return {
        stop_id: stop.id,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        image_url: stop.images[0] ?? null,
        script_adult: assetsForStop?.script_adult ?? null,
        script_preteen: assetsForStop?.script_preteen ?? null,
        audio_url_adult: assetsForStop?.audio_url_adult ?? null,
        audio_url_preteen: assetsForStop?.audio_url_preteen ?? null,
        position: index,
      };
    });

    return NextResponse.json({
      route: {
        id: route.id,
        title: route.title,
        length_minutes: parseInt(route.durationLabel, 10) || 30,
        transport_mode: "walk",
        status: latestJob?.status ?? "ready",
      },
      stops,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load preset route" }, { status: 500 });
  }
}
