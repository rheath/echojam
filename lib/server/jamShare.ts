import "server-only";

import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { getRouteById, getRouteNarratorLabel, type Persona } from "@/app/content/salemRoutes";
import { cityPlaceholderImage, proxyGoogleImageUrl } from "@/lib/placesImages";
import { personaCatalog } from "@/lib/personas/catalog";
import { getPresetCityMeta } from "@/lib/presetOverview";

type JamRow = {
  id: string;
  route_id: string | null;
  persona: string | null;
  host_name: string | null;
  current_stop: number | null;
};

type CustomRouteRow = {
  id: string;
  title: string;
  length_minutes: number | null;
  transport_mode: "walk" | "drive" | null;
  city: string | null;
  story_by: string | null;
  story_by_source: "instagram" | "tiktok" | "social" | null;
};

type CustomRouteStopRow = {
  image_url: string | null;
};

export type JamSharePayload = {
  jamFound: boolean;
  jamId: string;
  title: string;
  description: string;
  imageUrl: string;
  posterTitle: string;
  posterSubtitle: string;
  posterBackgroundImageUrl: string | null;
  city: string | null;
  canonicalPath: string;
  deepLinkPath: string;
};

const FALLBACK_TITLE = "Shared EchoJam tour";
const FALLBACK_DESCRIPTION = "Open this EchoJam tour and start walking.";
const DEFAULT_CITY = "salem";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function toNullableTrimmed(value: string | null | undefined) {
  const v = value?.trim();
  return v ? v : null;
}

function isStrongImage(value: string | null | undefined) {
  const v = toNullableTrimmed(value);
  if (!v) return false;
  return !v.toLowerCase().includes("/placeholder");
}

function firstImage(candidates: Array<string | null | undefined>) {
  for (const candidate of candidates) {
    if (isStrongImage(candidate)) return candidate!.trim();
  }
  for (const candidate of candidates) {
    const v = toNullableTrimmed(candidate);
    if (v) return v;
  }
  return null;
}

function isPersona(value: string | null | undefined): value is Persona {
  return value === "adult" || value === "preteen" || value === "ghost" || value === "custom";
}

function toPersonaLabel(persona: string | null | undefined) {
  if (!isPersona(persona)) return null;
  return personaCatalog[persona].displayName;
}

function makeDescription(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => toNullableTrimmed(part ?? null))
    .filter((part): part is string => Boolean(part))
    .join(" • ");
}

function parseRouteMinutes(durationLabel: string | null | undefined) {
  const parsed = parseInt(durationLabel ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatStopCount(count: number) {
  return `${count} Stop${count === 1 ? "" : "s"}`;
}

function makePosterSubtitle(stopCount: number, storyByLabel: string | null) {
  const storyBy = storyByLabel || "EchoJam";
  return `${formatStopCount(stopCount)} • Story by ${storyBy}`;
}

function fallbackPayload(jamId: string): JamSharePayload {
  return {
    jamFound: false,
    jamId,
    title: FALLBACK_TITLE,
    description: FALLBACK_DESCRIPTION,
    imageUrl: cityPlaceholderImage(DEFAULT_CITY),
    posterTitle: "EchoJam",
    posterSubtitle: FALLBACK_DESCRIPTION,
    posterBackgroundImageUrl: null,
    city: DEFAULT_CITY,
    canonicalPath: `/j/${encodeURIComponent(jamId)}`,
    deepLinkPath: `/?jam=${encodeURIComponent(jamId)}`,
  };
}

async function resolveCustomRouteSummary(routeId: string) {
  const admin = getAdmin();
  if (!admin) return null;

  const routeSelectWithStoryBy = "id,title,length_minutes,transport_mode,city,story_by,story_by_source";
  const routeSelectLegacy = "id,title,length_minutes,transport_mode,city";
  let route: CustomRouteRow | null = null;

  const routeWithStoryBy = await admin
    .from("custom_routes")
    .select(routeSelectWithStoryBy)
    .eq("id", routeId)
    .maybeSingle();
  if (routeWithStoryBy.error?.message?.toLowerCase().includes("story_by")) {
    const legacyRoute = await admin
      .from("custom_routes")
      .select(routeSelectLegacy)
      .eq("id", routeId)
      .maybeSingle();
    if (legacyRoute.error || !legacyRoute.data) return null;
    route = {
      ...(legacyRoute.data as Omit<CustomRouteRow, "story_by" | "story_by_source">),
      story_by: null,
      story_by_source: null,
    };
  } else {
    if (routeWithStoryBy.error || !routeWithStoryBy.data) return null;
    route = routeWithStoryBy.data as CustomRouteRow;
  }

  const { data: stops, error: stopsErr } = await admin
    .from("custom_route_stops")
    .select("image_url")
    .eq("route_id", routeId)
    .order("position", { ascending: true });
  if (stopsErr) return null;

  const typedRoute = route as CustomRouteRow;
  const typedStops = (stops ?? []) as CustomRouteStopRow[];

  const imageUrl =
    proxyGoogleImageUrl(firstImage(typedStops.map((stop) => stop.image_url))) ||
    cityPlaceholderImage(typedRoute.city || DEFAULT_CITY);
  const stopCount = typedStops.length;
  const minutes = typedRoute.length_minutes && typedRoute.length_minutes > 0 ? typedRoute.length_minutes : null;

  return {
    routeTitle: typedRoute.title || "Custom route",
    imageUrl,
    stopCount,
    minutes,
    transportMode: typedRoute.transport_mode || null,
    city: typedRoute.city || null,
    storyBy: typedRoute.story_by_source ? typedRoute.story_by : null,
  };
}

async function resolvePresetRouteSummary(routeId: string) {
  const route = getRouteById(routeId);
  if (!route) return null;

  const stopsWithPlaceIds = route.stops.filter((stop) => (stop.googlePlaceId || "").trim().length > 0);
  const cityMeta = route.city ? getPresetCityMeta(route.city) : null;
  const imageCandidates: string[] = [];

  if (stopsWithPlaceIds.length > 0) {
    let hash = 0;
    for (let i = 0; i < route.id.length; i += 1) {
      hash = (hash * 31 + route.id.charCodeAt(i)) >>> 0;
    }
    const index = hash % stopsWithPlaceIds.length;
    const placeId = (stopsWithPlaceIds[index]?.googlePlaceId || "").trim();
    if (placeId) {
      imageCandidates.push(`/api/google-image?kind=place-id-photo&placeId=${encodeURIComponent(placeId)}&maxWidthPx=1400`);
    }
  }

  if (cityMeta?.fallbackImage) {
    imageCandidates.push(cityMeta.fallbackImage);
  }

  for (const stop of route.stops) {
    for (const image of stop.images) imageCandidates.push(image);
  }

  const imageUrl = proxyGoogleImageUrl(firstImage(imageCandidates)) || cityPlaceholderImage(DEFAULT_CITY);
  return {
    routeTitle: route.title,
    imageUrl,
    stopCount: route.stops.length,
    minutes: parseRouteMinutes(route.durationLabel),
    transportMode: "walk" as const,
    city: route.city || DEFAULT_CITY,
  };
}

export const getJamSharePayload = cache(async (jamId: string): Promise<JamSharePayload> => {
  const admin = getAdmin();
  if (!admin) {
    if (process.env.NODE_ENV === "development") {
      console.warn("share metadata: missing Supabase env vars; using fallback payload");
    }
    return fallbackPayload(jamId);
  }

  const { data: jam, error } = await admin
    .from("jams")
    .select("id,route_id,persona,host_name,current_stop")
    .eq("id", jamId)
    .maybeSingle();

  if (error || !jam) return fallbackPayload(jamId);

  const jamRow = jam as JamRow;
  const routeRef = jamRow.route_id;
  let summary:
    | {
        routeTitle: string;
        imageUrl: string;
        stopCount: number;
        minutes: number | null;
        transportMode: "walk" | "drive" | null;
        city: string | null;
        storyBy?: string | null;
      }
    | null = null;

  if (routeRef?.startsWith("custom:")) {
    summary = await resolveCustomRouteSummary(routeRef.slice("custom:".length));
  } else if (routeRef) {
    summary = await resolvePresetRouteSummary(routeRef);
  }

  if (!summary) {
    return {
      ...fallbackPayload(jamId),
      jamFound: true,
      title: "EchoJam tour",
      posterTitle: "EchoJam tour",
    };
  }

  const personaLabel = routeRef && !routeRef.startsWith("custom:") && isPersona(jamRow.persona)
    ? getRouteNarratorLabel(getRouteById(routeRef), jamRow.persona)
    : toPersonaLabel(jamRow.persona);
  const posterSubtitle = makePosterSubtitle(summary.stopCount, summary.storyBy ?? personaLabel);
  const description = makeDescription([
    posterSubtitle,
    summary.minutes ? `${summary.minutes} mins` : null,
    summary.transportMode === "drive" ? "Drive route" : "Walk route",
  ]);

  return {
    jamFound: true,
    jamId,
    title: summary.routeTitle,
    description: description || posterSubtitle || FALLBACK_DESCRIPTION,
    imageUrl: summary.imageUrl,
    posterTitle: summary.routeTitle,
    posterSubtitle,
    posterBackgroundImageUrl: isStrongImage(summary.imageUrl) ? summary.imageUrl : null,
    city: summary.city,
    canonicalPath: `/j/${encodeURIComponent(jamId)}`,
    deepLinkPath: `/?jam=${encodeURIComponent(jamId)}`,
  };
});
