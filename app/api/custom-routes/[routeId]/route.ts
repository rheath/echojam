import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { toNullableTrimmed } from "@/lib/mixGeneration";
import { cityPlaceholderImage } from "@/lib/placesImages";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

type MappingRow = {
  stop_id: string;
  canonical_stop_id: string;
  position: number;
};

type CanonicalImageRow = {
  id: string;
  image_url: string | null;
  fallback_image_url: string | null;
};

type AssetRow = {
  canonical_stop_id: string;
  persona: "adult" | "preteen";
  script: string | null;
  audio_url: string | null;
};

function isNonPlaceholderImage(value: string | null | undefined) {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return false;
  return !normalized.toLowerCase().includes("/placeholder-");
}

export async function GET(_: Request, ctx: { params: Promise<{ routeId: string }> }) {
  try {
    const { routeId } = await ctx.params;
    const admin = getAdmin();

    const { data: route, error: routeErr } = await admin
      .from("custom_routes")
      .select("id,title,length_minutes,transport_mode,status,city")
      .eq("id", routeId)
      .single();
    if (routeErr) return NextResponse.json({ error: routeErr.message }, { status: 404 });

    const { data: stops, error: stopsErr } = await admin
      .from("custom_route_stops")
      .select("stop_id,title,lat,lng,image_url,script_adult,script_preteen,audio_url_adult,audio_url_preteen,position")
      .eq("route_id", routeId)
      .order("position", { ascending: true });
    if (stopsErr) return NextResponse.json({ error: stopsErr.message }, { status: 500 });

    const { data: mappings, error: mapErr } = await admin
      .from("route_stop_mappings")
      .select("stop_id,canonical_stop_id,position")
      .eq("route_kind", "custom")
      .in("route_id", [routeId, `custom:${routeId}`]);
    if (mapErr) return NextResponse.json({ error: mapErr.message }, { status: 500 });

    const mappingByStop = new Map<string, MappingRow>();
    const canonicalIds = new Set<string>();
    for (const row of (mappings ?? []) as MappingRow[]) {
      mappingByStop.set(row.stop_id, row);
      canonicalIds.add(row.canonical_stop_id);
    }

    let assets: AssetRow[] = [];
    let canonicalImages: CanonicalImageRow[] = [];
    if (canonicalIds.size > 0) {
      const { data: assetRows, error: assetsErr } = await admin
        .from("canonical_stop_assets")
        .select("canonical_stop_id,persona,script,audio_url")
        .in("canonical_stop_id", Array.from(canonicalIds));
      if (assetsErr) return NextResponse.json({ error: assetsErr.message }, { status: 500 });
      assets = (assetRows ?? []) as AssetRow[];

      const { data: imageRows, error: imagesErr } = await admin
        .from("canonical_stops")
        .select("id,image_url,fallback_image_url")
        .in("id", Array.from(canonicalIds));
      if (imagesErr) return NextResponse.json({ error: imagesErr.message }, { status: 500 });
      canonicalImages = (imageRows ?? []) as CanonicalImageRow[];
    }

    const assetsByCanonical = new Map<
      string,
      {
        script_adult: string | null;
        script_preteen: string | null;
        audio_url_adult: string | null;
        audio_url_preteen: string | null;
      }
    >();

    for (const row of assets) {
      const entry = assetsByCanonical.get(row.canonical_stop_id) ?? {
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
      assetsByCanonical.set(row.canonical_stop_id, entry);
    }

    const imageByCanonical = new Map<string, CanonicalImageRow>();
    for (const row of canonicalImages) {
      imageByCanonical.set(row.id, row);
    }

    const placeholder = cityPlaceholderImage(route.city);

    const normalizedStops = (stops ?? []).map((stop) => {
      const mapping = mappingByStop.get(stop.stop_id);
      const canonical = mapping ? assetsByCanonical.get(mapping.canonical_stop_id) : null;
      const canonicalImage = mapping ? imageByCanonical.get(mapping.canonical_stop_id) : null;

      const scriptAdult = canonical?.script_adult ?? toNullableTrimmed(stop.script_adult);
      const scriptPreteen = canonical?.script_preteen ?? toNullableTrimmed(stop.script_preteen);
      const audioAdult = canonical?.audio_url_adult ?? toNullableTrimmed(stop.audio_url_adult);
      const audioPreteen = canonical?.audio_url_preteen ?? toNullableTrimmed(stop.audio_url_preteen);
      const canonicalImageUrl = toNullableTrimmed(canonicalImage?.image_url);
      const curatedFallback = toNullableTrimmed(canonicalImage?.fallback_image_url);
      const stopImage = toNullableTrimmed(stop.image_url);
      const imageUrl =
        (isNonPlaceholderImage(canonicalImageUrl) ? canonicalImageUrl : null) ||
        (isNonPlaceholderImage(curatedFallback) ? curatedFallback : null) ||
        stopImage ||
        placeholder;

      return {
        ...stop,
        image_url: imageUrl,
        script_adult: scriptAdult,
        script_preteen: scriptPreteen,
        audio_url_adult: audioAdult,
        audio_url_preteen: audioPreteen,
      };
    });

    return NextResponse.json({ route, stops: normalizedStops });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load custom route" }, { status: 500 });
  }
}
