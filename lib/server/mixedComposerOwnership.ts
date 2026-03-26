import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComposerStop } from "@/lib/socialComposer";
import { toNullableTrimmed } from "@/lib/instagramImport";
import { normalizeMixedComposerSessionSnapshot } from "@/lib/mixedComposerSession";
import { cityPlaceholderImage } from "@/lib/placesImages";

type OwnedMixedComposerSessionRow = {
  id: string;
  owner_user_id: string | null;
  jam_id: string | null;
  base_route_id: string | null;
  draft_status: string | null;
  active_provider: string | null;
  route_title: string | null;
  custom_narrator_guidance: string | null;
  stops: unknown;
  instagram_draft_id: string | null;
  instagram_draft_ids: unknown;
  tiktok_draft_id: string | null;
  active_import_job: unknown;
  google_place_draft: unknown;
  created_at: string;
  updated_at: string;
};

type OwnedJamRow = {
  id: string;
  route_id: string | null;
  owner_user_id: string | null;
};

type OwnedRouteRow = {
  id: string;
  jam_id: string;
  owner_user_id: string | null;
  title: string | null;
  narrator_default: "adult" | "preteen" | "ghost" | "custom" | null;
  narrator_guidance: string | null;
  updated_at: string;
};

type OwnedRouteStopRow = {
  stop_id: string;
  title: string;
  lat: number;
  lng: number;
  image_url: string | null;
  google_place_id: string | null;
  source_provider: "instagram" | "tiktok" | "google_places" | null;
  source_kind: "social_import" | "place_search" | null;
  source_url: string | null;
  source_id: string | null;
  source_preview_image_url: string | null;
  source_creator_name: string | null;
  source_creator_url: string | null;
  source_creator_avatar_url: string | null;
  script_adult: string | null;
  script_preteen: string | null;
  script_ghost: string | null;
  script_custom: string | null;
  position: number;
};

export type OwnedMixedComposerJourneySummary = {
  jamId: string;
  routeId: string;
  sessionId: string | null;
  title: string;
  updatedAt: string;
  hasDraft: boolean;
};

function getScriptForRoutePersona(
  route: Pick<OwnedRouteRow, "narrator_default">,
  stop: Pick<
    OwnedRouteStopRow,
    "script_adult" | "script_preteen" | "script_ghost" | "script_custom"
  >
) {
  if (route.narrator_default === "preteen") {
    return toNullableTrimmed(stop.script_preteen);
  }
  if (route.narrator_default === "ghost") {
    return toNullableTrimmed(stop.script_ghost);
  }
  if (route.narrator_default === "custom") {
    return toNullableTrimmed(stop.script_custom) || toNullableTrimmed(stop.script_adult);
  }
  return toNullableTrimmed(stop.script_adult);
}

function mapRouteStopToComposerStop(
  route: Pick<OwnedRouteRow, "narrator_default">,
  stop: OwnedRouteStopRow
) {
  const provider = stop.source_provider ?? (stop.google_place_id ? "google_places" : "google_places");
  const kind = stop.source_kind ?? (provider === "google_places" ? "place_search" : "social_import");
  const image = toNullableTrimmed(stop.image_url) || cityPlaceholderImage("nearby");

  return {
    id: stop.stop_id,
    kind,
    provider,
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    image,
    googlePlaceId: toNullableTrimmed(stop.google_place_id),
    sourceUrl: toNullableTrimmed(stop.source_url),
    sourceId: toNullableTrimmed(stop.source_id),
    sourcePreviewImageUrl: toNullableTrimmed(stop.source_preview_image_url),
    creatorName: toNullableTrimmed(stop.source_creator_name),
    creatorUrl: toNullableTrimmed(stop.source_creator_url),
    creatorAvatarUrl: toNullableTrimmed(stop.source_creator_avatar_url),
    script: getScriptForRoutePersona(route, stop),
    scriptEditedByUser: null,
    originalDraftId: null,
  } satisfies ComposerStop;
}

export function extractCustomRouteId(routeRef: string | null | undefined) {
  const normalized = toNullableTrimmed(routeRef);
  if (!normalized || !normalized.startsWith("custom:")) return null;
  const routeId = normalized.slice("custom:".length).trim();
  return routeId || null;
}

export async function getOwnedMixedComposerSessionById(
  admin: SupabaseClient,
  sessionId: string,
  ownerUserId: string
) {
  const { data, error } = await admin
    .from("mixed_composer_sessions")
    .select(
      "id,owner_user_id,jam_id,base_route_id,draft_status,active_provider,route_title,custom_narrator_guidance,stops,instagram_draft_id,instagram_draft_ids,tiktok_draft_id,active_import_job,google_place_draft,created_at,updated_at"
    )
    .eq("id", sessionId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data ?? null) as OwnedMixedComposerSessionRow | null;
}

export async function listOwnedMixedComposerJourneys(
  admin: SupabaseClient,
  ownerUserId: string
) {
  const { data: liveRoutes, error: liveRoutesErr } = await admin
    .from("custom_routes")
    .select("id,jam_id,owner_user_id,title,updated_at")
    .eq("owner_user_id", ownerUserId)
    .eq("is_live", true)
    .order("updated_at", { ascending: false });
  if (liveRoutesErr) throw new Error(liveRoutesErr.message);

  const typedLiveRoutes = (liveRoutes ?? []) as Array<
    Pick<OwnedRouteRow, "id" | "jam_id" | "owner_user_id" | "title" | "updated_at">
  >;
  if (typedLiveRoutes.length === 0) return [] as OwnedMixedComposerJourneySummary[];

  const jamIds = Array.from(new Set(typedLiveRoutes.map((route) => route.jam_id).filter(Boolean)));
  const { data: sessions, error: sessionsErr } = await admin
    .from("mixed_composer_sessions")
    .select("id,jam_id,route_title,updated_at,draft_status")
    .eq("owner_user_id", ownerUserId)
    .in("jam_id", jamIds)
    .order("updated_at", { ascending: false });
  if (sessionsErr) throw new Error(sessionsErr.message);

  const latestSessionByJamId = new Map<
    string,
    { id: string; route_title: string | null; updated_at: string; draft_status: string | null }
  >();
  for (const session of (sessions ?? []) as Array<{
    id: string;
    jam_id: string | null;
    route_title: string | null;
    updated_at: string;
    draft_status: string | null;
  }>) {
    const jamId = toNullableTrimmed(session.jam_id);
    if (!jamId || latestSessionByJamId.has(jamId)) continue;
    latestSessionByJamId.set(jamId, session);
  }

  return typedLiveRoutes.map((route) => {
    const session = latestSessionByJamId.get(route.jam_id);
    return {
      jamId: route.jam_id,
      routeId: route.id,
      sessionId: session?.id ?? null,
      title: toNullableTrimmed(session?.route_title) || toNullableTrimmed(route.title) || "Untitled journey",
      updatedAt: session?.updated_at || route.updated_at,
      hasDraft: Boolean(session),
    } satisfies OwnedMixedComposerJourneySummary;
  });
}

export async function loadOwnedJamForMixedResume(
  admin: SupabaseClient,
  jamId: string,
  ownerUserId: string
) {
  const { data, error } = await admin
    .from("jams")
    .select("id,route_id,owner_user_id")
    .eq("id", jamId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data ?? null) as OwnedJamRow | null;
}

export async function findLatestOwnedMixedSessionForJam(
  admin: SupabaseClient,
  jamId: string,
  ownerUserId: string
) {
  const { data, error } = await admin
    .from("mixed_composer_sessions")
    .select(
      "id,owner_user_id,jam_id,base_route_id,draft_status,active_provider,route_title,custom_narrator_guidance,stops,instagram_draft_id,instagram_draft_ids,tiktok_draft_id,active_import_job,google_place_draft,created_at,updated_at"
    )
    .eq("owner_user_id", ownerUserId)
    .eq("jam_id", jamId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data ?? null) as OwnedMixedComposerSessionRow | null;
}

export async function createMixedComposerSessionFromRoute(args: {
  admin: SupabaseClient;
  ownerUserId: string;
  jamId: string;
  routeId: string;
}) {
  const { data: routes, error: routeErr } = await args.admin
    .from("custom_routes")
    .select("id,jam_id,owner_user_id,title,narrator_default,narrator_guidance,updated_at")
    .eq("id", args.routeId)
    .eq("owner_user_id", args.ownerUserId)
    .limit(1);
  if (routeErr) throw new Error(routeErr.message);

  const route = ((routes ?? [])[0] ?? null) as OwnedRouteRow | null;
  if (!route) {
    throw new Error("Published journey was not found.");
  }

  const { data: stops, error: stopsErr } = await args.admin
    .from("custom_route_stops")
    .select(
      "stop_id,title,lat,lng,image_url,google_place_id,source_provider,source_kind,source_url,source_id,source_preview_image_url,source_creator_name,source_creator_url,source_creator_avatar_url,script_adult,script_preteen,script_ghost,script_custom,position"
    )
    .eq("route_id", route.id)
    .order("position", { ascending: true });
  if (stopsErr) throw new Error(stopsErr.message);

  const snapshot = normalizeMixedComposerSessionSnapshot({
    activeProvider:
      ((stops ?? []) as OwnedRouteStopRow[]).find((stop) => stop.source_provider)?.source_provider ??
      "instagram",
    routeTitle: toNullableTrimmed(route.title),
    customNarratorGuidance: toNullableTrimmed(route.narrator_guidance),
    stops: ((stops ?? []) as OwnedRouteStopRow[]).map((stop) =>
      mapRouteStopToComposerStop(route, stop)
    ),
    instagramDraftId: null,
    instagramDraftIds: [],
    tiktokDraftId: null,
    activeImportJob: null,
    googlePlaceDraft: null,
  });

  const { data: created, error: createErr } = await args.admin
    .from("mixed_composer_sessions")
    .insert({
      owner_user_id: args.ownerUserId,
      jam_id: args.jamId,
      base_route_id: route.id,
      draft_status: "draft",
      active_provider: snapshot.activeProvider,
      route_title: snapshot.routeTitle,
      custom_narrator_guidance: snapshot.customNarratorGuidance,
      stops: snapshot.stops,
      instagram_draft_id: snapshot.instagramDraftId,
      instagram_draft_ids: snapshot.instagramDraftIds,
      tiktok_draft_id: snapshot.tiktokDraftId,
      active_import_job: snapshot.activeImportJob,
      google_place_draft: snapshot.googlePlaceDraft,
    })
    .select("id")
    .single();
  if (createErr || !created?.id) {
    throw new Error(createErr?.message || "Failed to create a private draft session.");
  }

  return created.id as string;
}
