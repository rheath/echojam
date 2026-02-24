import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(_: Request, ctx: { params: Promise<{ routeId: string }> }) {
  try {
    const { routeId } = await ctx.params;
    const admin = getAdmin();

    const { data: route, error: routeErr } = await admin
      .from("custom_routes")
      .select("id,title,length_minutes,transport_mode,status")
      .eq("id", routeId)
      .single();
    if (routeErr) return NextResponse.json({ error: routeErr.message }, { status: 404 });

    const { data: stops, error: stopsErr } = await admin
      .from("custom_route_stops")
      .select("stop_id,title,lat,lng,image_url,script_adult,script_preteen,audio_url_adult,audio_url_preteen,position")
      .eq("route_id", routeId)
      .order("position", { ascending: true });
    if (stopsErr) return NextResponse.json({ error: stopsErr.message }, { status: 500 });

    return NextResponse.json({ route, stops: stops ?? [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load custom route" }, { status: 500 });
  }
}
