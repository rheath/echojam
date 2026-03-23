import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getRouteById } from "@/app/content/salemRoutes";
import { toNullableTrimmed } from "@/lib/mixGeneration";
import { buildPresetStopsWithOverview, normalizePresetCity } from "@/lib/presetOverview";
import { listPresetRouteStopAssets, mapPresetAssetsByStop } from "@/lib/presetRouteAssets";
import { buildGooglePlaceIdPhotoUrl, isValidGooglePlaceId, proxyGoogleImageUrl } from "@/lib/placesImages";

type MappingRow = {
  stop_id: string;
  canonical_stop_id: string;
  position: number;
};

type CanonicalImageRow = {
  id: string;
  image_url: string | null;
};

type PresetRouteStopRecord = {
  stop_id: string;
  title: string;
  lat: number;
  lng: number;
  image_url: string;
  script_adult: string | null;
  script_preteen: string | null;
  script_ghost: string | null;
  audio_url_adult: string | null;
  audio_url_preteen: string | null;
  audio_url_ghost: string | null;
  is_overview: boolean;
  position: number;
};

type LoadPresetRouteStopsOptions = {
  includeAssets?: boolean;
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

function isNonPlaceholderImage(value: string | null | undefined) {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return false;
  return !normalized.toLowerCase().includes("/placeholder");
}

function pickStopImage(
  canonicalImage: string | null | undefined,
  placeIdPhoto: string | null | undefined,
  routeImage: string | null | undefined,
  placeholder: string
) {
  const strongCandidates = [canonicalImage, placeIdPhoto, routeImage]
    .map((value) => toNullableTrimmed(value))
    .filter((value): value is string => Boolean(value) && isNonPlaceholderImage(value));

  if (strongCandidates[0]) return strongCandidates[0];
  return toNullableTrimmed(routeImage) || placeholder;
}

async function loadPresetRouteStops(
  routeId: string,
  cityHint?: string | null,
  options?: LoadPresetRouteStopsOptions
) {
  const includeAssets = options?.includeAssets ?? true;
  const route = getRouteById(routeId);
  if (!route) return null;

  const city = route.city ?? normalizePresetCity(cityHint);
  const presetStops = buildPresetStopsWithOverview(route.stops, city, route.contentPriority);

  let admin: ReturnType<typeof getAdmin> | null = null;
  try {
    admin = getAdmin();
  } catch (e) {
    console.error("preset-routes: admin client unavailable", e);
  }

  if (!admin) {
    const stops: PresetRouteStopRecord[] = presetStops.map((stop, index) => ({
      stop_id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image_url: proxyGoogleImageUrl(toNullableTrimmed(stop.image)) || "/images/salem/placeholder.png",
      script_adult: null,
      script_preteen: null,
      script_ghost: null,
      audio_url_adult: null,
      audio_url_preteen: null,
      audio_url_ghost: null,
      is_overview: Boolean(stop.isOverview),
      position: index,
    }));
    return {
      route: {
        id: route.id,
        title: route.title,
        length_minutes: route.durationMinutes || 30,
        transport_mode: "walk" as const,
        status: "ready",
      },
      stops,
    };
  }

  const { data: mappings, error: mapErr } = await admin
    .from("route_stop_mappings")
    .select("stop_id,canonical_stop_id,position")
    .eq("route_kind", "preset")
    .eq("route_id", routeId)
    .order("position", { ascending: true });
  if (mapErr) {
    console.error("preset-routes: mapping query failed", mapErr);
  }

  const mappingByStop = new Map<string, MappingRow>();
  const canonicalIds = new Set<string>();
  for (const row of ((mappings ?? []) as MappingRow[])) {
    mappingByStop.set(row.stop_id, row);
    canonicalIds.add(row.canonical_stop_id);
  }

  let canonicalImages: CanonicalImageRow[] = [];
  if (canonicalIds.size > 0) {
    const { data: imageRows, error: imagesErr } = await admin
      .from("canonical_stops")
      .select("id,image_url")
      .in("id", Array.from(canonicalIds));
    if (imagesErr) {
      console.error("preset-routes: canonical image query failed", imagesErr);
    } else {
      canonicalImages = (imageRows ?? []) as CanonicalImageRow[];
    }
  }

  let assetsByStop = new Map<
    string,
    {
      script_adult: string | null;
      script_preteen: string | null;
      script_ghost: string | null;
      audio_url_adult: string | null;
      audio_url_preteen: string | null;
      audio_url_ghost: string | null;
    }
  >();
  if (includeAssets) {
    try {
      const assetRows = await listPresetRouteStopAssets(
        admin,
        routeId,
        presetStops.map((stop) => stop.id)
      );
      assetsByStop = mapPresetAssetsByStop(assetRows);
    } catch (assetsErr) {
      console.error("preset-routes: assets query failed", assetsErr);
    }
  }

  const imageByCanonical = new Map<string, CanonicalImageRow>();
  for (const row of canonicalImages) {
    imageByCanonical.set(row.id, row);
  }
  const { data: latestJob } = await admin
    .from("preset_generation_jobs")
    .select("status")
    .eq("preset_route_id", routeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const stops: PresetRouteStopRecord[] = presetStops.map((stop, index) => {
    const mapping = mappingByStop.get(stop.id);
    const assetsForStop = assetsByStop.get(stop.id) ?? null;
    const imageForStop = mapping ? imageByCanonical.get(mapping.canonical_stop_id) : null;
    const canonicalImage = toNullableTrimmed(imageForStop?.image_url);
    const placeIdPhoto = isValidGooglePlaceId(stop.googlePlaceId)
      ? buildGooglePlaceIdPhotoUrl(stop.googlePlaceId!.trim())
      : null;
    const routeImage = toNullableTrimmed(stop.image);

    return {
      stop_id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image_url:
        proxyGoogleImageUrl(
          pickStopImage(canonicalImage, placeIdPhoto, routeImage, "/images/salem/placeholder.png")
        ) ||
        "/images/salem/placeholder.png",
      script_adult: includeAssets ? assetsForStop?.script_adult ?? null : null,
      script_preteen: includeAssets ? assetsForStop?.script_preteen ?? null : null,
      script_ghost: includeAssets ? assetsForStop?.script_ghost ?? null : null,
      audio_url_adult: includeAssets ? assetsForStop?.audio_url_adult ?? null : null,
      audio_url_preteen: includeAssets ? assetsForStop?.audio_url_preteen ?? null : null,
      audio_url_ghost: includeAssets ? assetsForStop?.audio_url_ghost ?? null : null,
      is_overview: Boolean(stop.isOverview),
      position: index,
    };
  });

  return {
    route: {
      id: route.id,
      title: route.title,
      length_minutes: route.durationMinutes || 30,
      transport_mode: "walk" as const,
      status: latestJob?.status ?? "ready",
    },
    stops,
  };
}

export async function loadPresetRoutePreviewStops(routeId: string, cityHint?: string | null) {
  const payload = await loadPresetRouteStops(routeId, cityHint, { includeAssets: false });
  if (!payload) return null;
  return payload.stops
    .filter((stop) => !stop.is_overview)
    .map((stop) => ({
      stop_id: stop.stop_id,
      title: stop.title,
      image_url: stop.image_url,
      position: stop.position,
      is_overview: stop.is_overview,
    }));
}

export async function loadPresetRoutePayload(routeId: string, cityHint?: string | null) {
  return loadPresetRouteStops(routeId, cityHint, { includeAssets: true });
}
