import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StopInput } from "@/lib/mixGeneration";

export type RouteKind = "preset" | "custom";

export type CanonicalStopRow = {
  id: string;
  city: string;
  title: string;
  lat: number;
  lng: number;
  image_url: string | null;
  image_source?: "places" | "curated" | "placeholder" | "link_seed" | null;
  fallback_image_url?: string | null;
  google_place_id?: string | null;
  image_last_checked_at?: string | null;
};

export const CANONICAL_MATCH_RADIUS_METERS = 50;

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const avgLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(avgLatRad);
  const dLat = (aLat - bLat) * metersPerLat;
  const dLng = (aLng - bLng) * metersPerLng;
  return Math.hypot(dLat, dLng);
}

function canonicalId(prefix: string, key: string) {
  return `${prefix}-${createHash("sha1").update(key).digest("hex").slice(0, 20)}`;
}

export function canonicalIdForPresetStop(city: string, stop: StopInput) {
  return canonicalId("canon-preset", `${city}|${stop.id}`);
}

function canonicalIdForCustomStop(city: string, stop: StopInput) {
  const key = `${city}|${stop.title.toLowerCase()}|${stop.lat.toFixed(6)}|${stop.lng.toFixed(6)}`;
  return canonicalId("canon-custom", key);
}

export async function findNearestCanonicalStop(
  admin: SupabaseClient,
  city: string,
  lat: number,
  lng: number
): Promise<CanonicalStopRow | null> {
  const { data, error } = await admin
    .from("canonical_stops")
    .select("id,city,title,lat,lng,image_url,image_source,fallback_image_url,google_place_id,image_last_checked_at")
    .eq("city", city);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as CanonicalStopRow[];
  let best: CanonicalStopRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    const d = distanceMeters(lat, lng, row.lat, row.lng);
    if (d < bestDistance) {
      bestDistance = d;
      best = row;
    }
  }

  if (!best || bestDistance > CANONICAL_MATCH_RADIUS_METERS) return null;
  return best;
}

function isPlaceholderImage(url: string | null | undefined) {
  if (!url) return true;
  const value = url.trim().toLowerCase();
  if (!value) return true;
  return value.includes("/placeholder-");
}

function isStrongImageSource(source: CanonicalStopRow["image_source"]) {
  return source === "places" || source === "curated";
}

async function getCanonicalStopById(admin: SupabaseClient, id: string) {
  const { data, error } = await admin
    .from("canonical_stops")
    .select("id,city,title,lat,lng,image_url,image_source,fallback_image_url,google_place_id,image_last_checked_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as CanonicalStopRow | null;
}

async function seedLinkImageIfAllowed(
  admin: SupabaseClient,
  row: CanonicalStopRow,
  imageUrl: string | null | undefined
) {
  const incoming = (imageUrl || "").trim();
  if (!incoming || isPlaceholderImage(incoming)) return row;
  if (isStrongImageSource(row.image_source)) return row;
  if (row.image_source === "link_seed" && !isPlaceholderImage(row.image_url)) return row;

  const { data, error } = await admin
    .from("canonical_stops")
    .update({
      image_url: incoming,
      image_source: "link_seed",
    })
    .eq("id", row.id)
    .select("id,city,title,lat,lng,image_url,image_source,fallback_image_url,google_place_id,image_last_checked_at")
    .single();
  if (error || !data) return row;
  return data as CanonicalStopRow;
}

export async function ensureCanonicalStopForPreset(
  admin: SupabaseClient,
  city: string,
  stop: StopInput
): Promise<CanonicalStopRow> {
  const id = canonicalIdForPresetStop(city, stop);
  const existing = await getCanonicalStopById(admin, id);
  if (existing) {
    await admin
      .from("canonical_stops")
      .update({
        city,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        source: "preset_seed",
      })
      .eq("id", id);
    const refreshed = (await getCanonicalStopById(admin, id)) ?? existing;
    return seedLinkImageIfAllowed(admin, refreshed, stop.image);
  }

  const { data, error } = await admin
    .from("canonical_stops")
    .insert({
      id,
      city,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image_url: isPlaceholderImage(stop.image) ? null : stop.image,
      image_source: isPlaceholderImage(stop.image) ? "placeholder" : "link_seed",
      source: "preset_seed",
    })
    .select("id,city,title,lat,lng,image_url,image_source,fallback_image_url,google_place_id,image_last_checked_at")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to upsert preset canonical stop");
  return data as CanonicalStopRow;
}

export async function ensureCanonicalStopForCustom(
  admin: SupabaseClient,
  city: string,
  stop: StopInput
): Promise<CanonicalStopRow> {
  const nearest = await findNearestCanonicalStop(admin, city, stop.lat, stop.lng);
  const stopImage = (stop.image || "").trim();

  if (nearest) {
    const currentSource = nearest.image_source || "placeholder";
    const hasStrongImage = ["places", "curated"].includes(currentSource) && !isPlaceholderImage(nearest.image_url);
    const incomingUseful = stopImage.length > 0 && !isPlaceholderImage(stopImage);
    const canSeedFromLink = currentSource === "placeholder" || !nearest.image_url;

    if (!hasStrongImage && incomingUseful && canSeedFromLink) {
      const { data, error } = await admin
        .from("canonical_stops")
        .update({
          image_url: stopImage,
          image_source: "link_seed",
        })
        .eq("id", nearest.id)
        .select("id,city,title,lat,lng,image_url,image_source,fallback_image_url,google_place_id,image_last_checked_at")
        .single();
      if (!error && data) return data as CanonicalStopRow;
    }

    return nearest;
  }

  const id = canonicalIdForCustomStop(city, stop);
  const existingById = await getCanonicalStopById(admin, id);
  if (existingById) {
    return seedLinkImageIfAllowed(admin, existingById, stopImage);
  }

  const { data, error } = await admin
    .from("canonical_stops")
    .insert({
      id,
      city,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image_url: stopImage || null,
      image_source: stopImage && !isPlaceholderImage(stopImage) ? "link_seed" : "placeholder",
      source: "custom_link",
    })
    .select("id,city,title,lat,lng,image_url,image_source,fallback_image_url,google_place_id,image_last_checked_at")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to upsert custom canonical stop");
  return data as CanonicalStopRow;
}

export async function upsertRouteStopMapping(
  admin: SupabaseClient,
  routeKind: RouteKind,
  routeId: string,
  stopId: string,
  canonicalStopId: string,
  position: number
) {
  const { error } = await admin.from("route_stop_mappings").upsert(
    {
      route_kind: routeKind,
      route_id: routeId,
      stop_id: stopId,
      canonical_stop_id: canonicalStopId,
      position,
    },
    { onConflict: "route_kind,route_id,stop_id" }
  );
  if (error) throw new Error(error.message);
}
