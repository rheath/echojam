import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  buildInstagramProfileUrl,
  deriveInstagramRouteAttribution,
  parseInstagramProfileImageUrlFromHtml,
} from "@/lib/instagramImport";
import { toNullableAudioUrl, toNullableTrimmed } from "@/lib/mixGeneration";
import { cityPlaceholderImage, proxyGoogleImageUrl } from "@/lib/placesImages";

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
  image_source: "places" | "curated" | "placeholder" | "link_seed" | null;
};

type AssetRow = {
  canonical_stop_id: string;
  persona: "adult" | "preteen" | "ghost";
  script: string | null;
  audio_url: string | null;
};

type StopRow = {
  stop_id: string;
  title: string;
  lat: number;
  lng: number;
  image_url: string | null;
  stop_kind?: "story" | "arrival" | null;
  distance_along_route_meters?: number | null;
  trigger_radius_meters?: number | null;
  script_adult: string | null;
  script_preteen: string | null;
  script_ghost?: string | null;
  script_custom?: string | null;
  audio_url_adult: string | null;
  audio_url_preteen: string | null;
  audio_url_ghost?: string | null;
  audio_url_custom?: string | null;
  position: number;
};

type RouteRow = {
  id: string;
  title: string;
  length_minutes: number;
  transport_mode: "walk" | "drive";
  status: "queued" | "generating" | "generating_script" | "generating_audio" | "ready" | "ready_with_warnings" | "failed";
  city: string | null;
  narrator_default: "adult" | "preteen" | "ghost" | "custom" | null;
  narrator_guidance: string | null;
  narrator_voice: string | null;
  experience_kind: "mix" | "follow_along" | null;
  origin_label: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  destination_label: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  route_distance_meters: number | null;
  route_duration_seconds: number | null;
  route_polyline: [number, number][] | null;
  story_by: string | null;
  story_by_url: string | null;
  story_by_avatar_url: string | null;
  story_by_source: "instagram" | null;
};

type InstagramDraftAttributionRow = {
  source_owner_title: string | null;
};

const INSTAGRAM_FETCH_TIMEOUT_MS = 4_000;
const INSTAGRAM_FETCH_USER_AGENTS = [
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
];

function isNonPlaceholderImage(value: string | null | undefined) {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return false;
  return !normalized.toLowerCase().includes("/placeholder");
}

function isMissingGhostColumnError(message: string | null | undefined) {
  const normalized = (message ?? "").toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("script_ghost")) return true;
  if (normalized.includes("audio_url_ghost")) return true;
  if (normalized.includes("script_custom")) return true;
  if (normalized.includes("audio_url_custom")) return true;
  return normalized.includes("column") && normalized.includes("does not exist") && normalized.includes("custom_route_stops");
}

function isMissingStoryByColumnError(message: string | null | undefined) {
  const normalized = (message ?? "").toLowerCase();
  if (!normalized) return false;
  const isStoryByLookup =
    normalized.includes("story_by") ||
    normalized.includes("story_by_url") ||
    normalized.includes("story_by_avatar_url") ||
    normalized.includes("story_by_source");
  return (
    isStoryByLookup &&
    ((normalized.includes("column") && normalized.includes("does not exist")) ||
      (normalized.includes("could not find") && normalized.includes("schema cache")))
  );
}

function pickStopImage(
  canonicalImage: string | null | undefined,
  curatedFallback: string | null | undefined,
  stopImage: string | null | undefined,
  canonicalSource: CanonicalImageRow["image_source"],
  placeholder: string
) {
  const preferStopSpecific =
    canonicalSource === "places" &&
    isNonPlaceholderImage(stopImage) &&
    isNonPlaceholderImage(canonicalImage);
  const rankedCandidates = preferStopSpecific
    ? [stopImage, canonicalImage, curatedFallback]
    : [canonicalImage, curatedFallback, stopImage];

  const strongCandidates = rankedCandidates
    .map((value) => toNullableTrimmed(value))
    .filter((value): value is string => Boolean(value) && isNonPlaceholderImage(value));

  if (strongCandidates[0]) return strongCandidates[0];
  return toNullableTrimmed(stopImage) || placeholder;
}

async function fetchInstagramProfileImageUrl(profileUrl: string) {
  for (const userAgent of INSTAGRAM_FETCH_USER_AGENTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INSTAGRAM_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(profileUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cache: "no-store",
      });
      if (!response.ok) continue;
      const html = await response.text();
      const imageUrl = parseInstagramProfileImageUrlFromHtml(html);
      if (imageUrl) return imageUrl;
    } catch {
      continue;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return null;
}

async function hydrateInstagramRouteAttribution(
  admin: ReturnType<typeof getAdmin>,
  route: RouteRow
) {
  if (route.story_by_source === "instagram" && toNullableTrimmed(route.story_by)) {
    return route;
  }

  const { data: instagramDrafts, error: instagramDraftsErr } = await admin
    .from("instagram_import_drafts")
    .select("source_owner_title")
    .eq("published_route_id", route.id);
  if (instagramDraftsErr) {
    return route;
  }

  const attribution = deriveInstagramRouteAttribution(
    ((instagramDrafts ?? []) as InstagramDraftAttributionRow[]).map((draft) => ({
      ownerTitle: draft.source_owner_title,
    }))
  );
  if (!attribution.storyBy || attribution.storyBySource !== "instagram") {
    return route;
  }
  const storyByUrl = attribution.storyByUrl || buildInstagramProfileUrl(attribution.storyBy);
  const storyByAvatarUrl =
    route.story_by_avatar_url ||
    attribution.storyByAvatarUrl ||
    (storyByUrl ? await fetchInstagramProfileImageUrl(storyByUrl).catch(() => null) : null);

  return {
    ...route,
    story_by: attribution.storyBy,
    story_by_url: storyByUrl,
    story_by_avatar_url: storyByAvatarUrl,
    story_by_source: attribution.storyBySource,
  };
}

export async function GET(_: Request, ctx: { params: Promise<{ routeId: string }> }) {
  try {
    const { routeId } = await ctx.params;
    const admin = getAdmin();
    const routeSelectWithStoryBy =
      "id,title,length_minutes,transport_mode,status,city,narrator_default,narrator_guidance,narrator_voice,experience_kind,origin_label,origin_lat,origin_lng,destination_label,destination_lat,destination_lng,route_distance_meters,route_duration_seconds,route_polyline,story_by,story_by_url,story_by_avatar_url,story_by_source";
    const routeSelectLegacy =
      "id,title,length_minutes,transport_mode,status,city,narrator_default,narrator_guidance,narrator_voice,experience_kind,origin_label,origin_lat,origin_lng,destination_label,destination_lat,destination_lng,route_distance_meters,route_duration_seconds,route_polyline";
    let route: RouteRow;

    const routeWithStoryByResult = await admin
      .from("custom_routes")
      .select(routeSelectWithStoryBy)
      .eq("id", routeId)
      .single();

    if (routeWithStoryByResult.error && isMissingStoryByColumnError(routeWithStoryByResult.error.message)) {
      const legacyRouteResult = await admin
        .from("custom_routes")
        .select(routeSelectLegacy)
        .eq("id", routeId)
        .single();
      if (legacyRouteResult.error || !legacyRouteResult.data) {
        return NextResponse.json({ error: legacyRouteResult.error?.message || "Route not found" }, { status: 404 });
      }
      route = {
        ...(legacyRouteResult.data as Omit<RouteRow, "story_by" | "story_by_url" | "story_by_avatar_url" | "story_by_source">),
        story_by: null,
        story_by_url: null,
        story_by_avatar_url: null,
        story_by_source: null,
      };
    } else {
      if (routeWithStoryByResult.error || !routeWithStoryByResult.data) {
        return NextResponse.json({ error: routeWithStoryByResult.error?.message || "Route not found" }, { status: 404 });
      }
      route = routeWithStoryByResult.data as RouteRow;
    }
    route = await hydrateInstagramRouteAttribution(admin, route);

    const stopsSelectWithGhost =
      "stop_id,title,lat,lng,image_url,stop_kind,distance_along_route_meters,trigger_radius_meters,script_adult,script_preteen,script_ghost,script_custom,audio_url_adult,audio_url_preteen,audio_url_ghost,audio_url_custom,position";
    const stopsSelectLegacy =
      "stop_id,title,lat,lng,image_url,stop_kind,distance_along_route_meters,trigger_radius_meters,script_adult,script_preteen,audio_url_adult,audio_url_preteen,position";
    let stops: StopRow[] = [];

    const { data: stopsWithGhost, error: stopsWithGhostErr } = await admin
      .from("custom_route_stops")
      .select(stopsSelectWithGhost)
      .eq("route_id", routeId)
      .order("position", { ascending: true });

    if (stopsWithGhostErr && isMissingGhostColumnError(stopsWithGhostErr.message)) {
      const { data: legacyStops, error: legacyStopsErr } = await admin
        .from("custom_route_stops")
        .select(stopsSelectLegacy)
        .eq("route_id", routeId)
        .order("position", { ascending: true });
      if (legacyStopsErr) return NextResponse.json({ error: legacyStopsErr.message }, { status: 500 });
      stops = (legacyStops ?? []) as StopRow[];
    } else {
      if (stopsWithGhostErr) return NextResponse.json({ error: stopsWithGhostErr.message }, { status: 500 });
      stops = (stopsWithGhost ?? []) as StopRow[];
    }

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
        .select("id,image_url,fallback_image_url,image_source")
        .in("id", Array.from(canonicalIds));
      if (imagesErr) return NextResponse.json({ error: imagesErr.message }, { status: 500 });
      canonicalImages = (imageRows ?? []) as CanonicalImageRow[];
    }

    const assetsByCanonical = new Map<
      string,
      {
        script_adult: string | null;
        script_preteen: string | null;
        script_ghost: string | null;
        script_custom: string | null;
        audio_url_adult: string | null;
        audio_url_preteen: string | null;
        audio_url_ghost: string | null;
        audio_url_custom: string | null;
      }
    >();

    for (const row of assets) {
      const entry = assetsByCanonical.get(row.canonical_stop_id) ?? {
        script_adult: null,
        script_preteen: null,
        script_ghost: null,
        script_custom: null,
        audio_url_adult: null,
        audio_url_preteen: null,
        audio_url_ghost: null,
        audio_url_custom: null,
      };

      const script = toNullableTrimmed(row.script);
      const audioUrl = toNullableAudioUrl(row.audio_url);
      if (row.persona === "adult") {
        entry.script_adult = script;
        entry.audio_url_adult = audioUrl;
      } else if (row.persona === "preteen") {
        entry.script_preteen = script;
        entry.audio_url_preteen = audioUrl;
      } else {
        entry.script_ghost = script;
        entry.audio_url_ghost = audioUrl;
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
      const scriptGhost = canonical?.script_ghost ?? toNullableTrimmed(stop.script_ghost);
      const scriptCustom = toNullableTrimmed(stop.script_custom);
      const audioAdult = canonical?.audio_url_adult ?? toNullableAudioUrl(stop.audio_url_adult);
      const audioPreteen = canonical?.audio_url_preteen ?? toNullableAudioUrl(stop.audio_url_preteen);
      const audioGhost = canonical?.audio_url_ghost ?? toNullableAudioUrl(stop.audio_url_ghost);
      const audioCustom = toNullableAudioUrl(stop.audio_url_custom);
      const canonicalImageUrl = toNullableTrimmed(canonicalImage?.image_url);
      const curatedFallback = toNullableTrimmed(canonicalImage?.fallback_image_url);
      const stopImage = toNullableTrimmed(stop.image_url);
      const imageUrl = pickStopImage(
        canonicalImageUrl,
        curatedFallback,
        stopImage,
        canonicalImage?.image_source ?? null,
        placeholder
      );

      return {
        ...stop,
        image_url: proxyGoogleImageUrl(imageUrl) || imageUrl,
        script_adult: scriptAdult,
        script_preteen: scriptPreteen,
        script_ghost: scriptGhost,
        script_custom: scriptCustom,
        audio_url_adult: audioAdult,
        audio_url_preteen: audioPreteen,
        audio_url_ghost: audioGhost,
        audio_url_custom: audioCustom,
      };
    });

    return NextResponse.json({ route, stops: normalizedStops });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load custom route" }, { status: 500 });
  }
}
