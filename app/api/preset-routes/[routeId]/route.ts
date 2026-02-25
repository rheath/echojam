import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById } from "@/app/content/salemRoutes";
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
    const route = getRouteById(routeId);
    if (!route) return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });

    const admin = getAdmin();

    const { data: mappings, error: mapErr } = await admin
      .from("route_stop_mappings")
      .select("stop_id,canonical_stop_id,position")
      .eq("route_kind", "preset")
      .eq("route_id", routeId)
      .order("position", { ascending: true });
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
    const placeholder = cityPlaceholderImage("salem");

    const { data: latestJob } = await admin
      .from("preset_generation_jobs")
      .select("status")
      .eq("preset_route_id", routeId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const stops = route.stops.map((stop, index) => {
      const mapping = mappingByStop.get(stop.id);
      const assetsForStop = mapping ? assetsByCanonical.get(mapping.canonical_stop_id) : null;
      const imageForStop = mapping ? imageByCanonical.get(mapping.canonical_stop_id) : null;
      const canonicalImage = toNullableTrimmed(imageForStop?.image_url);
      const curatedFallback = toNullableTrimmed(imageForStop?.fallback_image_url);
      const routeImage = toNullableTrimmed(stop.images[0]);

      return {
        stop_id: stop.id,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        image_url:
          (isNonPlaceholderImage(canonicalImage) ? canonicalImage : null) ||
          (isNonPlaceholderImage(curatedFallback) ? curatedFallback : null) ||
          routeImage ||
          placeholder,
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
