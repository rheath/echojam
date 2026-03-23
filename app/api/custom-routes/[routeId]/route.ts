import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  buildInstagramProfileUrl,
  deriveInstagramRouteAttribution,
  proxyInstagramImageUrl,
} from "@/lib/instagramImport";
import { getJourneyAccess } from "@/lib/server/journeyAccess";
import { getRequestAuthUser } from "@/lib/server/requestAuth";
import { toNullableAudioUrl, toNullableTrimmed } from "@/lib/mixGeneration";
import { cityPlaceholderImage, proxyGoogleImageUrl } from "@/lib/placesImages";
import { isPresetOverviewStopId } from "@/lib/presetOverview";
import { fetchInstagramProfileImageUrl } from "@/lib/server/instagramProfileImage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  google_place_id: string | null;
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
  source_provider?: "instagram" | "tiktok" | "google_places" | null;
  source_kind?: "social_import" | "place_search" | null;
  source_url?: string | null;
  source_id?: string | null;
  source_creator_name?: string | null;
  source_creator_url?: string | null;
  source_creator_avatar_url?: string | null;
  google_place_id?: string | null;
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
  experience_kind: "mix" | "follow_along" | "walk_discovery" | null;
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
  story_by_source: "instagram" | "tiktok" | "social" | null;
};

type InstagramDraftAttributionRow = {
  source_owner_title: string | null;
};

type PatchBody = {
  stopIds?: string[];
};

type RouteStopPositionRow = {
  stop_id: string;
  position: number;
};

type RouteStopMappingRow = {
  route_id: string;
  stop_id: string;
  canonical_stop_id: string;
  position: number;
};

const INSTAGRAM_FETCH_TIMEOUT_MS = 4_000;
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

function isMissingSourceColumnError(message: string | null | undefined) {
  const normalized = (message ?? "").toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("source_provider") ||
    normalized.includes("source_kind") ||
    normalized.includes("source_url") ||
    normalized.includes("source_id") ||
    normalized.includes("source_creator")
  );
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

async function isUsableImageUrl(url: string) {
  const normalized = toNullableTrimmed(url);
  if (!normalized) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INSTAGRAM_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(normalized, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/*",
      },
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") || "";
    response.body?.cancel().catch(() => {
      // ignore body cancellation failures
    });
    return response.ok && contentType.toLowerCase().startsWith("image/");
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveInstagramAvatarUrl(params: {
  storyBy: string | null;
  storyByUrl: string | null;
  storedAvatarUrl: string | null;
}) {
  const storyBy = toNullableTrimmed(params.storyBy);
  const storyByUrl =
    toNullableTrimmed(params.storyByUrl) ||
    (storyBy ? buildInstagramProfileUrl(storyBy) : null);
  const storedAvatarUrl = toNullableTrimmed(params.storedAvatarUrl);

  if (storedAvatarUrl && await isUsableImageUrl(storedAvatarUrl)) {
    return {
      storyByUrl,
      storyByAvatarUrl: storedAvatarUrl,
    };
  }

  const storyByAvatarUrl =
    storyByUrl ? await fetchInstagramProfileImageUrl(storyByUrl).catch(() => null) : null;
  return {
    storyByUrl,
    storyByAvatarUrl: toNullableTrimmed(storyByAvatarUrl),
  };
}

async function persistInstagramAvatarUrl(
  admin: ReturnType<typeof getAdmin>,
  route: Pick<RouteRow, "id" | "story_by_url" | "story_by_avatar_url">,
  next: { storyByUrl: string | null; storyByAvatarUrl: string | null }
) {
  const storyByUrlChanged = (toNullableTrimmed(route.story_by_url) || null) !== next.storyByUrl;
  const storyByAvatarChanged =
    (toNullableTrimmed(route.story_by_avatar_url) || null) !== next.storyByAvatarUrl;
  if (!storyByUrlChanged && !storyByAvatarChanged) return;

  const { error } = await admin
    .from("custom_routes")
    .update({
      story_by_url: next.storyByUrl,
      story_by_avatar_url: next.storyByAvatarUrl,
    })
    .eq("id", route.id);
  if (!error || isMissingStoryByColumnError(error.message)) return;
  console.error("Failed to persist refreshed Instagram avatar URL.", error);
}

async function hydrateInstagramRouteAttribution(
  admin: ReturnType<typeof getAdmin>,
  route: RouteRow
) {
  if (route.story_by_source === "instagram" && toNullableTrimmed(route.story_by)) {
    const resolvedAvatar = await resolveInstagramAvatarUrl({
      storyBy: route.story_by,
      storyByUrl: route.story_by_url,
      storedAvatarUrl: route.story_by_avatar_url,
    });
    await persistInstagramAvatarUrl(admin, route, resolvedAvatar);
    return {
      ...route,
      story_by_url: resolvedAvatar.storyByUrl,
      story_by_avatar_url: resolvedAvatar.storyByAvatarUrl,
    };
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
  const resolvedAvatar = await resolveInstagramAvatarUrl({
    storyBy: attribution.storyBy,
    storyByUrl: attribution.storyByUrl || buildInstagramProfileUrl(attribution.storyBy),
    storedAvatarUrl: route.story_by_avatar_url || attribution.storyByAvatarUrl,
  });
  await persistInstagramAvatarUrl(
    admin,
    {
      id: route.id,
      story_by_url: route.story_by_url,
      story_by_avatar_url: route.story_by_avatar_url,
    },
    resolvedAvatar
  );

  return {
    ...route,
    story_by: attribution.storyBy,
    story_by_url: resolvedAvatar.storyByUrl,
    story_by_avatar_url: resolvedAvatar.storyByAvatarUrl,
    story_by_source: attribution.storyBySource,
  };
}

function prioritizeOverviewStopIds(stopIds: string[]) {
  const overview = stopIds.filter((stopId) => isPresetOverviewStopId(stopId));
  if (overview.length === 0) return stopIds;
  const rest = stopIds.filter((stopId) => !isPresetOverviewStopId(stopId));
  return [...overview, ...rest];
}

export async function GET(req: Request, ctx: { params: Promise<{ routeId: string }> }) {
  try {
    const { routeId } = await ctx.params;
    const authUser = await getRequestAuthUser(req);
    const access = await getJourneyAccess({
      userId: authUser?.id ?? null,
      sourceKind: "custom",
      sourceId: routeId,
    });
    if (access.accessState === "locked") {
      return NextResponse.json(
        {
          access: "locked",
          teaser: access.offering
            ? {
                slug: access.offering.slug,
                title: access.offering.title,
                creatorLabel: access.offering.creatorLabel,
                coverImageUrl: access.offering.coverImageUrl,
                teaserDescription: access.offering.teaserDescription,
                durationMinutes: access.offering.durationMinutes,
                stopCount: access.offering.stopCount,
                firstStopTitle: access.offering.firstStopTitle,
                pricing: access.offering.pricing,
              }
            : null,
        },
        { status: 402 }
      );
    }

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
      "stop_id,title,lat,lng,image_url,source_provider,source_kind,source_url,source_id,source_creator_name,source_creator_url,source_creator_avatar_url,stop_kind,distance_along_route_meters,trigger_radius_meters,script_adult,script_preteen,script_ghost,script_custom,audio_url_adult,audio_url_preteen,audio_url_ghost,audio_url_custom,position";
    const stopsSelectLegacy =
      "stop_id,title,lat,lng,image_url,stop_kind,distance_along_route_meters,trigger_radius_meters,script_adult,script_preteen,audio_url_adult,audio_url_preteen,position";
    let stops: StopRow[] = [];

    const { data: stopsWithGhost, error: stopsWithGhostErr } = await admin
      .from("custom_route_stops")
      .select(stopsSelectWithGhost)
      .eq("route_id", routeId)
      .order("position", { ascending: true });

    if (
      stopsWithGhostErr &&
      (isMissingGhostColumnError(stopsWithGhostErr.message) || isMissingSourceColumnError(stopsWithGhostErr.message))
    ) {
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
        .select("id,image_url,fallback_image_url,image_source,google_place_id")
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
        source_provider: stop.source_provider ?? null,
        source_kind: stop.source_kind ?? null,
        source_url: toNullableTrimmed(stop.source_url),
        source_id: toNullableTrimmed(stop.source_id),
        source_creator_name: toNullableTrimmed(stop.source_creator_name),
        source_creator_url: toNullableTrimmed(stop.source_creator_url),
        source_creator_avatar_url: toNullableTrimmed(stop.source_creator_avatar_url),
        google_place_id: toNullableTrimmed(canonicalImage?.google_place_id),
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

    const responseRoute = {
      ...route,
      story_by_avatar_url: proxyInstagramImageUrl(route.story_by_avatar_url) || null,
    };

    return NextResponse.json({ route: responseRoute, stops: normalizedStops });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load custom route" }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ routeId: string }> }) {
  try {
    const { routeId } = await ctx.params;
    const admin = getAdmin();
    const body = (await req.json().catch(() => ({}))) as PatchBody;
    const rawStopIds = Array.isArray(body.stopIds)
      ? body.stopIds
          .map((value) => toNullableTrimmed(value))
          .filter((value): value is string => Boolean(value))
      : [];

    if (rawStopIds.length === 0) {
      return NextResponse.json({ error: "Choose at least 1 stop." }, { status: 400 });
    }

    const dedupedStopIds: string[] = [];
    const seenStopIds = new Set<string>();
    for (const stopId of rawStopIds) {
      if (seenStopIds.has(stopId)) {
        return NextResponse.json({ error: "Duplicate stop IDs are not allowed." }, { status: 400 });
      }
      seenStopIds.add(stopId);
      dedupedStopIds.push(stopId);
    }

    const nextStopIds = prioritizeOverviewStopIds(dedupedStopIds);

    const { data: route, error: routeErr } = await admin
      .from("custom_routes")
      .select("id")
      .eq("id", routeId)
      .single();
    if (routeErr || !route?.id) {
      return NextResponse.json({ error: routeErr?.message || "Route not found" }, { status: 404 });
    }

    const { data: currentStops, error: currentStopsErr } = await admin
      .from("custom_route_stops")
      .select("stop_id,position")
      .eq("route_id", routeId)
      .order("position", { ascending: true });
    if (currentStopsErr) {
      return NextResponse.json({ error: currentStopsErr.message }, { status: 500 });
    }

    const currentStopRows = (currentStops ?? []) as RouteStopPositionRow[];
    const currentStopIds = new Set(currentStopRows.map((stop) => stop.stop_id));
    if (currentStopRows.length === 0) {
      return NextResponse.json({ error: "Route has no stops to update." }, { status: 400 });
    }
    if (nextStopIds.some((stopId) => !currentStopIds.has(stopId))) {
      return NextResponse.json({ error: "One or more stops do not belong to this route." }, { status: 400 });
    }

    const removedStopIds = currentStopRows
      .map((stop) => stop.stop_id)
      .filter((stopId) => !seenStopIds.has(stopId));

    if (removedStopIds.length > 0) {
      const { error: deleteStopsErr } = await admin
        .from("custom_route_stops")
        .delete()
        .eq("route_id", routeId)
        .in("stop_id", removedStopIds);
      if (deleteStopsErr) {
        return NextResponse.json({ error: deleteStopsErr.message }, { status: 500 });
      }

      const { error: deleteMappingsErr } = await admin
        .from("route_stop_mappings")
        .delete()
        .eq("route_kind", "custom")
        .in("route_id", [routeId, `custom:${routeId}`])
        .in("stop_id", removedStopIds);
      if (deleteMappingsErr) {
        return NextResponse.json({ error: deleteMappingsErr.message }, { status: 500 });
      }
    }

    const positionByStopId = new Map(nextStopIds.map((stopId, index) => [stopId, index]));
    const stopUpdateResults = await Promise.all(
      nextStopIds.map(async (stopId, index) => {
        const result = await admin
          .from("custom_route_stops")
          .update({ position: index })
          .eq("route_id", routeId)
          .eq("stop_id", stopId);
        return result.error;
      })
    );
    const stopUpdateErr = stopUpdateResults.find(Boolean);
    if (stopUpdateErr) {
      return NextResponse.json({ error: stopUpdateErr.message }, { status: 500 });
    }

    const { data: mappings, error: mappingsErr } = await admin
      .from("route_stop_mappings")
      .select("route_id,stop_id,canonical_stop_id,position")
      .eq("route_kind", "custom")
      .in("route_id", [routeId, `custom:${routeId}`])
      .in("stop_id", nextStopIds);
    if (mappingsErr) {
      return NextResponse.json({ error: mappingsErr.message }, { status: 500 });
    }

    const mappingUpdateResults = await Promise.all(
      ((mappings ?? []) as RouteStopMappingRow[]).map(async (mapping) => {
        const nextPosition = positionByStopId.get(mapping.stop_id);
        if (typeof nextPosition !== "number") return null;
        const result = await admin
          .from("route_stop_mappings")
          .update({ position: nextPosition })
          .eq("route_kind", "custom")
          .eq("route_id", mapping.route_id)
          .eq("stop_id", mapping.stop_id);
        return result.error;
      })
    );
    const mappingUpdateErr = mappingUpdateResults.find(Boolean);
    if (mappingUpdateErr) {
      return NextResponse.json({ error: mappingUpdateErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, routeId, stopIds: nextStopIds });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to update custom route stops" },
      { status: 500 }
    );
  }
}
