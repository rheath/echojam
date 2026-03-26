import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ensureCanonicalStopForCustom,
  upsertRouteStopMapping,
} from "@/lib/canonicalStops";
import {
  rewriteScriptOpenerWithOpenAI,
  selectCustomNarratorVoice,
  type CustomNarratorVoice,
  generateScriptWithOpenAI,
  getSwitchConfig,
  isUsableGeneratedAudioUrl,
  shouldRegenerateAudio,
  shouldRegenerateScript,
  synthesizeSpeechWithOpenAI,
  toNullableAudioUrl,
  toNullableTrimmed,
  uploadNarrationAudio,
  type Persona,
  type StopInput,
} from "@/lib/mixGeneration";
import {
  buildMixedRouteOpenerContext,
  type MixedRouteOpenerFamily,
} from "@/lib/mixedRouteOpeners";
import {
  validateMixSelection,
  type TransportMode,
} from "@/lib/mixConstraints";

export type CustomRouteExperienceKind = "mix" | "follow_along" | "walk_discovery";
export type CustomRouteStopKind = "story" | "arrival";

export type PreparedCustomRouteStop = StopInput & {
  stopKind?: CustomRouteStopKind;
  distanceAlongRouteMeters?: number | null;
  triggerRadiusMeters?: number | null;
};

export type PrepareCustomRouteJobInput = {
  admin: SupabaseClient;
  jamId?: string | null;
  mixedComposerSessionId?: string | null;
  ownerUserId?: string | null;
  createRouteRevision?: boolean;
  city: string;
  transportMode: TransportMode;
  lengthMinutes: number;
  persona: Persona;
  stops: PreparedCustomRouteStop[];
  source?: "manual" | "instant" | "follow_along";
  routeTitle?: string | null;
  narratorGuidance?: string | null;
  experienceKind?: CustomRouteExperienceKind;
  routeMeta?: {
    originLabel?: string | null;
    originLat?: number | null;
    originLng?: number | null;
    destinationLabel?: string | null;
    destinationLat?: number | null;
    destinationLng?: number | null;
    routeDistanceMeters?: number | null;
    routeDurationSeconds?: number | null;
    routePolyline?: [number, number][] | null;
  };
  narratorVoice?: CustomNarratorVoice | null;
  routeAttribution?: {
    storyBy?: string | null;
    storyByUrl?: string | null;
    storyByAvatarUrl?: string | null;
    storyBySource?: "instagram" | "tiktok" | "social" | null;
  };
};

export type PreparedCustomRouteJob = {
  jamId: string;
  routeId: string;
  routeRef: string;
  jobId: string;
  city: string;
  transportMode: TransportMode;
  lengthMinutes: number;
  experienceKind: CustomRouteExperienceKind;
  persona: Persona;
  narratorGuidance: string | null;
  stops: PreparedCustomRouteStop[];
};

type MixedRouteOpenerRewriteInput = {
  stop: PreparedCustomRouteStop;
  script: string;
  openerFamily: MixedRouteOpenerFamily;
  blockedLeadIns: string[];
  stopIndex: number;
  totalStops: number;
};

type MixedRouteOpenerRewriteResult = {
  scripts: Array<string | null>;
  warningCount: number;
  lastWarning: string;
};

type ActiveGenerationJobRow = {
  id: string;
  status:
    | "queued"
    | "generating_script"
    | "generating_audio"
    | "ready"
    | "ready_with_warnings"
    | "failed";
};

const SCRIPT_PATCH_BY_PERSONA = {
  adult: (script: string | null) => ({ script_adult: script }),
  preteen: (script: string | null) => ({ script_preteen: script }),
  ghost: (script: string | null) => ({ script_ghost: script }),
  custom: (script: string | null) => ({ script_custom: script }),
} as const;

const AUDIO_PATCH_BY_PERSONA = {
  adult: (audioUrl: string | null) => ({ audio_url_adult: audioUrl }),
  preteen: (audioUrl: string | null) => ({ audio_url_preteen: audioUrl }),
  ghost: (audioUrl: string | null) => ({ audio_url_ghost: audioUrl }),
  custom: (audioUrl: string | null) => ({ audio_url_custom: audioUrl }),
} as const;

function isMissingStoryByColumnError(message: string | null | undefined) {
  const normalized = (message || "").toLowerCase();
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

function isMissingMixedComposerSessionColumnError(
  message: string | null | undefined
) {
  const normalized = (message || "").toLowerCase();
  if (!normalized || !normalized.includes("mixed_composer_session_id")) {
    return false;
  }
  return (
    (normalized.includes("column") && normalized.includes("does not exist")) ||
    (normalized.includes("could not find") && normalized.includes("schema cache"))
  );
}

function isMissingSourcePreviewImageColumnError(
  message: string | null | undefined
) {
  const normalized = (message || "").toLowerCase();
  if (!normalized || !normalized.includes("source_preview_image_url")) {
    return false;
  }
  return (
    (normalized.includes("column") && normalized.includes("does not exist")) ||
    (normalized.includes("could not find") && normalized.includes("schema cache"))
  );
}

function formatCityLabel(city: string) {
  const normalized = (city || "").trim().toLowerCase();
  if (!normalized || normalized === "nearby") return "Nearby";
  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ") || "Nearby";
}

function deriveRouteTitle(
  routeTitle: string | null | undefined,
  city: string,
  stops: PreparedCustomRouteStop[],
  experienceKind: CustomRouteExperienceKind
) {
  const requestedRouteTitle = (routeTitle || "").trim();
  if (requestedRouteTitle) return requestedRouteTitle;

  if (experienceKind === "follow_along") {
    const destinationStop = stops[stops.length - 1];
    const destinationTitle = (destinationStop?.title || "").trim();
    if (destinationTitle) return `Follow Along to ${destinationTitle}`;
  }

  if (stops.length === 1) {
    const singleStopTitle = (stops[0]?.title || "").trim();
    if (singleStopTitle) return singleStopTitle;
  }

  return `${formatCityLabel(city)} Mix`;
}

function normalizeRouteAttribution(
  value: PrepareCustomRouteJobInput["routeAttribution"]
) {
  return {
    story_by: toNullableTrimmed(value?.storyBy),
    story_by_url: toNullableTrimmed(value?.storyByUrl),
    story_by_avatar_url: toNullableTrimmed(value?.storyByAvatarUrl),
    story_by_source: value?.storyBySource ?? null,
  };
}

function normalizePrefilledScript(value: string | null | undefined) {
  return toNullableTrimmed(value);
}

export function shouldTreatPrefilledScriptAsFinal(
  experienceKind: CustomRouteExperienceKind,
  prefilledScript: string | null | undefined
) {
  return experienceKind === "mix" && Boolean(normalizePrefilledScript(prefilledScript));
}

export function shouldReuseCanonicalAudioForRouteScript(args: {
  experienceKind: CustomRouteExperienceKind;
  isCustomNarrator: boolean;
  forceAudio: boolean;
  currentScript: string | null | undefined;
  canonicalScript: string | null | undefined;
}) {
  const currentScript = toNullableTrimmed(args.currentScript);
  const canonicalScript = toNullableTrimmed(args.canonicalScript);
  const hasRouteSpecificScript =
    args.experienceKind === "mix" &&
    Boolean(currentScript) &&
    currentScript !== canonicalScript;
  return !args.forceAudio && !args.isCustomNarrator && !hasRouteSpecificScript;
}

function buildCustomRouteStopInsert(
  routeId: string,
  stop: PreparedCustomRouteStop,
  idx: number
) {
  return {
    route_id: routeId,
    stop_id: stop.id,
    position: idx,
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    image_url: stop.image,
    stop_kind: stop.stopKind ?? "story",
    distance_along_route_meters:
      typeof stop.distanceAlongRouteMeters === "number"
        ? Math.round(stop.distanceAlongRouteMeters)
        : null,
    trigger_radius_meters:
      typeof stop.triggerRadiusMeters === "number"
        ? Math.round(stop.triggerRadiusMeters)
        : null,
    source_provider: stop.sourceProvider ?? null,
    source_kind: stop.sourceKind ?? null,
    source_url: toNullableTrimmed(stop.sourceUrl),
    source_id: toNullableTrimmed(stop.sourceId),
    source_preview_image_url: toNullableTrimmed(stop.sourcePreviewImageUrl),
    source_creator_name: toNullableTrimmed(stop.sourceCreatorName),
    source_creator_url: toNullableTrimmed(stop.sourceCreatorUrl),
    source_creator_avatar_url: toNullableTrimmed(stop.sourceCreatorAvatarUrl),
  };
}

function buildLegacyCustomRouteStopInsert(
  routeId: string,
  stop: PreparedCustomRouteStop,
  idx: number
) {
  const insert = buildCustomRouteStopInsert(routeId, stop, idx);
  return {
    route_id: insert.route_id,
    stop_id: insert.stop_id,
    position: insert.position,
    title: insert.title,
    lat: insert.lat,
    lng: insert.lng,
    image_url: insert.image_url,
    stop_kind: insert.stop_kind,
    distance_along_route_meters: insert.distance_along_route_meters,
    trigger_radius_meters: insert.trigger_radius_meters,
    source_provider: insert.source_provider,
    source_kind: insert.source_kind,
    source_url: insert.source_url,
    source_id: insert.source_id,
    source_creator_name: insert.source_creator_name,
    source_creator_url: insert.source_creator_url,
    source_creator_avatar_url: insert.source_creator_avatar_url,
  };
}

export async function insertPreparedCustomRouteStops(args: {
  admin: SupabaseClient;
  routeId: string;
  stops: PreparedCustomRouteStop[];
}) {
  const inserts = args.stops.map((stop, idx) =>
    buildCustomRouteStopInsert(args.routeId, stop, idx)
  );

  const { error: stopsErr } = await args.admin
    .from("custom_route_stops")
    .insert(inserts);
  if (!stopsErr) return;
  if (!isMissingSourcePreviewImageColumnError(stopsErr.message)) {
    throw new Error(stopsErr.message);
  }

  const legacyInserts = args.stops.map((stop, idx) =>
    buildLegacyCustomRouteStopInsert(args.routeId, stop, idx)
  );
  const { error: legacyStopsErr } = await args.admin
    .from("custom_route_stops")
    .insert(legacyInserts);
  if (legacyStopsErr) {
    throw new Error(legacyStopsErr.message);
  }
}

export async function harmonizeMixedRouteStopScripts(args: {
  experienceKind: CustomRouteExperienceKind;
  persona: Persona;
  narratorGuidance: string | null;
  stops: PreparedCustomRouteStop[];
  scripts: Array<string | null | undefined>;
  rewriteScriptOpener: (input: MixedRouteOpenerRewriteInput) => Promise<string>;
}): Promise<MixedRouteOpenerRewriteResult> {
  const nextScripts: Array<string | null> = [];
  const finalizedScripts: string[] = [];
  let warningCount = 0;
  let lastWarning = "";

  for (let index = 0; index < args.stops.length; index += 1) {
    const stop = args.stops[index];
    const script = toNullableTrimmed(args.scripts[index]);
    if (!stop || !script) {
      nextScripts.push(script);
      continue;
    }

    if (
      args.experienceKind !== "mix" ||
      stop.scriptEditedByUser ||
      shouldTreatPrefilledScriptAsFinal(args.experienceKind, stop.prefilledScript)
    ) {
      nextScripts.push(script);
      finalizedScripts.push(script);
      continue;
    }

    const { openerFamily, blockedLeadIns } = buildMixedRouteOpenerContext(
      args.persona,
      index,
      finalizedScripts
    );

    try {
      const rewritten = toNullableTrimmed(
        await args.rewriteScriptOpener({
          stop,
          script,
          openerFamily,
          blockedLeadIns,
          stopIndex: index,
          totalStops: args.stops.length,
        })
      );
      const finalScript = rewritten || script;
      nextScripts.push(finalScript);
      finalizedScripts.push(finalScript);
    } catch (error) {
      warningCount += 1;
      lastWarning = `Opener harmonization failed for ${args.persona} at stop "${stop.title}": ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      nextScripts.push(script);
      finalizedScripts.push(script);
    }
  }

  return {
    scripts: nextScripts,
    warningCount,
    lastWarning,
  };
}

async function createJam(
  admin: SupabaseClient,
  persona: Persona,
  ownerUserId?: string | null
) {
  const { data: jam, error: jamErr } = await admin
    .from("jams")
    .insert({
      owner_user_id: toNullableTrimmed(ownerUserId),
      host_name: "Rob",
      route_id: null,
      persona,
      current_stop: 0,
      is_playing: false,
      position_ms: 0,
      preset_id: null,
    })
    .select("id")
    .single();
  if (jamErr || !jam?.id) {
    throw new Error(jamErr?.message || "Failed to create jam");
  }
  return jam.id as string;
}

function extractCustomRouteIdFromJamRouteRef(routeRef: string | null | undefined) {
  const normalized = toNullableTrimmed(routeRef);
  if (!normalized || !normalized.startsWith("custom:")) return null;
  const routeId = normalized.slice("custom:".length).trim();
  return routeId || null;
}

async function loadLiveCustomRouteIdForJam(admin: SupabaseClient, jamId: string) {
  const { data: jam, error: jamErr } = await admin
    .from("jams")
    .select("route_id")
    .eq("id", jamId)
    .maybeSingle();
  if (jamErr) {
    throw new Error(jamErr.message || "Failed to load jam route state");
  }

  const routeIdFromJam = extractCustomRouteIdFromJamRouteRef(
    (jam as { route_id?: string | null } | null)?.route_id ?? null
  );
  if (routeIdFromJam) return routeIdFromJam;

  const { data: liveRoute, error: liveRouteErr } = await admin
    .from("custom_routes")
    .select("id")
    .eq("jam_id", jamId)
    .eq("is_live", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (liveRouteErr) {
    throw new Error(liveRouteErr.message || "Failed to load live custom route");
  }
  return (liveRoute as { id?: string } | null)?.id ?? null;
}

function normalizeCustomNarratorSelection(
  persona: Persona,
  narratorGuidance: string | null
) {
  if (persona === "custom" && !narratorGuidance) {
    return {
      persona: "adult" as Persona,
      narratorGuidance: null,
      narratorVoice: null,
    };
  }

  return {
    persona,
    narratorGuidance,
    narratorVoice:
      persona === "custom" && narratorGuidance
        ? selectCustomNarratorVoice(narratorGuidance)
        : null,
  };
}

export async function prepareCustomRouteJob(
  input: PrepareCustomRouteJobInput
): Promise<PreparedCustomRouteJob> {
  const city = (input.city || "").trim().toLowerCase() || "nearby";
  const normalizedNarratorGuidance = toNullableTrimmed(input.narratorGuidance);
  const narratorSelection = normalizeCustomNarratorSelection(
    input.persona,
    normalizedNarratorGuidance
  );
  const narratorGuidance = narratorSelection.narratorGuidance;
  const persona = narratorSelection.persona;
  const experienceKind = input.experienceKind ?? "mix";
  const minStops = input.source === "instant" ? 1 : undefined;
  const validation = validateMixSelection(
    input.lengthMinutes,
    input.transportMode,
    input.stops.length,
    { minStops }
  );
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  let jamId = input.jamId ?? null;
  if (!jamId) {
    jamId = await createJam(input.admin, persona, input.ownerUserId);
  }

  const { data: activeJob } = await input.admin
    .from("mix_generation_jobs")
    .select("id,status")
    .eq("jam_id", jamId)
    .in("status", ["queued", "generating_script", "generating_audio"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if ((activeJob as ActiveGenerationJobRow | null)?.id) {
    throw new Error("A generation job is already in progress for this jam.");
  }

  const routeTitle = deriveRouteTitle(
    input.routeTitle,
    city,
    input.stops,
    experienceKind
  );
  const shouldCreateRouteRevision = Boolean(input.createRouteRevision && jamId);
  const existingRouteId = jamId
    ? await loadLiveCustomRouteIdForJam(input.admin, jamId)
    : null;

  const routePatch = {
    city,
    transport_mode: input.transportMode,
    length_minutes: input.lengthMinutes,
    title: routeTitle,
    narrator_default: persona,
    narrator_guidance: narratorGuidance,
    narrator_voice:
      persona === "custom"
        ? input.narratorVoice ?? narratorSelection.narratorVoice
        : null,
    status: "generating",
    experience_kind: experienceKind,
    origin_label: toNullableTrimmed(input.routeMeta?.originLabel),
    origin_lat:
      typeof input.routeMeta?.originLat === "number"
        ? input.routeMeta.originLat
        : null,
    origin_lng:
      typeof input.routeMeta?.originLng === "number"
        ? input.routeMeta.originLng
        : null,
    destination_label: toNullableTrimmed(input.routeMeta?.destinationLabel),
    destination_lat:
      typeof input.routeMeta?.destinationLat === "number"
        ? input.routeMeta.destinationLat
        : null,
    destination_lng:
      typeof input.routeMeta?.destinationLng === "number"
        ? input.routeMeta.destinationLng
        : null,
    route_distance_meters:
      typeof input.routeMeta?.routeDistanceMeters === "number"
        ? Math.round(input.routeMeta.routeDistanceMeters)
        : null,
    route_duration_seconds:
      typeof input.routeMeta?.routeDurationSeconds === "number"
        ? Math.round(input.routeMeta.routeDurationSeconds)
        : null,
    route_polyline:
      input.routeMeta?.routePolyline && input.routeMeta.routePolyline.length > 1
        ? input.routeMeta.routePolyline
        : null,
    mixed_composer_session_id: toNullableTrimmed(input.mixedComposerSessionId),
    ...normalizeRouteAttribution(input.routeAttribution),
  };
  const routePatchWithoutMixedComposerSession = {
    city: routePatch.city,
    transport_mode: routePatch.transport_mode,
    length_minutes: routePatch.length_minutes,
    title: routePatch.title,
    narrator_default: routePatch.narrator_default,
    narrator_guidance: routePatch.narrator_guidance,
    narrator_voice: routePatch.narrator_voice,
    status: routePatch.status,
    experience_kind: routePatch.experience_kind,
    origin_label: routePatch.origin_label,
    origin_lat: routePatch.origin_lat,
    origin_lng: routePatch.origin_lng,
    destination_label: routePatch.destination_label,
    destination_lat: routePatch.destination_lat,
    destination_lng: routePatch.destination_lng,
    route_distance_meters: routePatch.route_distance_meters,
    route_duration_seconds: routePatch.route_duration_seconds,
    route_polyline: routePatch.route_polyline,
    ...normalizeRouteAttribution(input.routeAttribution),
  };
  const legacyRoutePatch = {
    city: routePatchWithoutMixedComposerSession.city,
    transport_mode: routePatchWithoutMixedComposerSession.transport_mode,
    length_minutes: routePatchWithoutMixedComposerSession.length_minutes,
    title: routePatchWithoutMixedComposerSession.title,
    narrator_default: routePatchWithoutMixedComposerSession.narrator_default,
    narrator_guidance: routePatchWithoutMixedComposerSession.narrator_guidance,
    narrator_voice: routePatchWithoutMixedComposerSession.narrator_voice,
    status: routePatchWithoutMixedComposerSession.status,
    experience_kind: routePatchWithoutMixedComposerSession.experience_kind,
    origin_label: routePatchWithoutMixedComposerSession.origin_label,
    origin_lat: routePatchWithoutMixedComposerSession.origin_lat,
    origin_lng: routePatchWithoutMixedComposerSession.origin_lng,
    destination_label: routePatchWithoutMixedComposerSession.destination_label,
    destination_lat: routePatchWithoutMixedComposerSession.destination_lat,
    destination_lng: routePatchWithoutMixedComposerSession.destination_lng,
    route_distance_meters: routePatchWithoutMixedComposerSession.route_distance_meters,
    route_duration_seconds: routePatchWithoutMixedComposerSession.route_duration_seconds,
    route_polyline: routePatchWithoutMixedComposerSession.route_polyline,
  };
  const routeInsertMetadata = {
    owner_user_id: toNullableTrimmed(input.ownerUserId),
    is_live: !shouldCreateRouteRevision,
    base_route_id: shouldCreateRouteRevision ? toNullableTrimmed(existingRouteId) : null,
    superseded_at: null,
    published_at: shouldCreateRouteRevision ? null : new Date().toISOString(),
  };

  let routeId = shouldCreateRouteRevision ? undefined : existingRouteId ?? undefined;
  if (routeId) {
    const { error: updateRouteErr } = await input.admin
      .from("custom_routes")
      .update(routePatch)
      .eq("id", routeId);
    if (updateRouteErr) {
      if (isMissingMixedComposerSessionColumnError(updateRouteErr.message)) {
        const { error: updateWithoutMixedErr } = await input.admin
          .from("custom_routes")
          .update(routePatchWithoutMixedComposerSession)
          .eq("id", routeId);
        if (!updateWithoutMixedErr) {
          // handled by fallback without mixed composer session column
        } else if (isMissingStoryByColumnError(updateWithoutMixedErr.message)) {
          const { error: legacyUpdateRouteErr } = await input.admin
            .from("custom_routes")
            .update(legacyRoutePatch)
            .eq("id", routeId);
          if (legacyUpdateRouteErr) {
            throw new Error(
              legacyUpdateRouteErr.message || "Failed to update custom route"
            );
          }
        } else {
          throw new Error(
            updateWithoutMixedErr.message || "Failed to update custom route"
          );
        }
      } else if (isMissingStoryByColumnError(updateRouteErr.message)) {
        const { error: legacyUpdateRouteErr } = await input.admin
          .from("custom_routes")
          .update(legacyRoutePatch)
          .eq("id", routeId);
        if (legacyUpdateRouteErr) {
          throw new Error(
            legacyUpdateRouteErr.message || "Failed to update custom route"
          );
        }
      } else {
        throw new Error(
          updateRouteErr.message || "Failed to update custom route"
        );
      }
    }
  } else {
    const { data: route, error: routeErr } = await input.admin
      .from("custom_routes")
      .insert({
        jam_id: jamId,
        ...routeInsertMetadata,
        ...routePatch,
      })
      .select("id")
      .single();
    if (routeErr && isMissingMixedComposerSessionColumnError(routeErr.message)) {
      const { data: routeWithoutMixed, error: routeWithoutMixedErr } = await input.admin
        .from("custom_routes")
        .insert({
          jam_id: jamId,
          ...routeInsertMetadata,
          ...routePatchWithoutMixedComposerSession,
        })
        .select("id")
        .single();
      if (routeWithoutMixedErr && isMissingStoryByColumnError(routeWithoutMixedErr.message)) {
        const { data: legacyRoute, error: legacyRouteErr } = await input.admin
          .from("custom_routes")
          .insert({
            jam_id: jamId,
            ...routeInsertMetadata,
            ...legacyRoutePatch,
          })
          .select("id")
          .single();
        if (legacyRouteErr || !legacyRoute?.id) {
          throw new Error(legacyRouteErr?.message || "Failed to create custom route");
        }
        routeId = legacyRoute.id as string;
      } else if (routeWithoutMixedErr || !routeWithoutMixed?.id) {
        throw new Error(routeWithoutMixedErr?.message || "Failed to create custom route");
      } else {
        routeId = routeWithoutMixed.id as string;
      }
    } else if (routeErr && isMissingStoryByColumnError(routeErr.message)) {
      const { data: legacyRoute, error: legacyRouteErr } = await input.admin
        .from("custom_routes")
        .insert({
          jam_id: jamId,
          ...routeInsertMetadata,
          ...legacyRoutePatch,
        })
        .select("id")
        .single();
      if (legacyRouteErr || !legacyRoute?.id) {
        throw new Error(legacyRouteErr?.message || "Failed to create custom route");
      }
      routeId = legacyRoute.id as string;
    } else if (routeErr || !route?.id) {
      throw new Error(routeErr?.message || "Failed to create custom route");
    } else {
      routeId = route.id as string;
    }
  }
  if (!routeId) throw new Error("Failed to resolve custom route id");

  const { error: deleteStopsErr } = await input.admin
    .from("custom_route_stops")
    .delete()
    .eq("route_id", routeId);
  if (deleteStopsErr) {
    throw new Error(
      deleteStopsErr.message || "Failed to clear previous custom route stops"
    );
  }
  const { error: deleteMappingsErr } = await input.admin
    .from("route_stop_mappings")
    .delete()
    .eq("route_kind", "custom")
    .eq("route_id", routeId);
  if (deleteMappingsErr) {
    throw new Error(
      deleteMappingsErr.message ||
        "Failed to clear previous custom route mappings"
    );
  }
  await input.admin
    .from("jams")
    .update({
      ...(shouldCreateRouteRevision ? {} : { route_id: `custom:${routeId}` }),
      persona,
      current_stop: 0,
      completed_at: null,
      preset_id: null,
    })
    .eq("id", jamId);

  await insertPreparedCustomRouteStops({
    admin: input.admin,
    routeId,
    stops: input.stops,
  });

  const { data: job, error: jobErr } = await input.admin
    .from("mix_generation_jobs")
    .insert({
      jam_id: jamId,
      route_id: routeId,
      status: "queued",
      progress: 0,
      message: "Queued",
    })
    .select("id")
    .single();
  if (jobErr || !job?.id) {
    throw new Error(jobErr?.message || "Failed to create mix generation job");
  }

  return {
    jamId,
    routeId,
    routeRef: `custom:${routeId}`,
    jobId: job.id as string,
    city,
    transportMode: input.transportMode,
    lengthMinutes: input.lengthMinutes,
    experienceKind,
    persona,
    narratorGuidance,
    stops: input.stops,
  };
}

async function finalizeCustomRoutePublication(
  admin: SupabaseClient,
  routeId: string
) {
  const { data: route, error: routeErr } = await admin
    .from("custom_routes")
    .select("id,jam_id,is_live,mixed_composer_session_id")
    .eq("id", routeId)
    .maybeSingle();
  if (routeErr) {
    throw new Error(routeErr.message || "Failed to load route publication state");
  }
  if (!route) return;

  const typedRoute = route as {
    id: string;
    jam_id: string;
    is_live?: boolean | null;
    mixed_composer_session_id?: string | null;
  };

  const nowIso = new Date().toISOString();
  await admin
    .from("custom_routes")
    .update({
      is_live: false,
      superseded_at: nowIso,
    })
    .eq("jam_id", typedRoute.jam_id)
    .eq("is_live", true)
    .neq("id", routeId);

  await admin
    .from("custom_routes")
    .update({
      is_live: true,
      superseded_at: null,
      published_at: nowIso,
    })
    .eq("id", routeId);

  await admin
    .from("jams")
    .update({
      route_id: `custom:${routeId}`,
    })
    .eq("id", typedRoute.jam_id);

  const mixedComposerSessionId = toNullableTrimmed(
    typedRoute.mixed_composer_session_id
  );
  if (!mixedComposerSessionId) return;

  await admin
    .from("mixed_composer_sessions")
    .update({
      jam_id: typedRoute.jam_id,
      base_route_id: routeId,
      draft_status: "draft",
    })
    .eq("id", mixedComposerSessionId);
}

export async function runCustomRouteGeneration(
  admin: SupabaseClient,
  jobId: string,
  routeId: string,
  city: string,
  transportMode: TransportMode,
  lengthMinutes: number,
  experienceKind: CustomRouteExperienceKind,
  persona: Persona,
  stops: PreparedCustomRouteStop[],
  narratorGuidance: string | null,
  narratorVoice: CustomNarratorVoice | null = null
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  const switchConfig = await getSwitchConfig();
  const forceScript = shouldRegenerateScript(switchConfig.mode);
  const forceAudio = shouldRegenerateAudio(switchConfig.mode);
  const isCustomNarrator = persona === "custom";

  const totalUnits = Math.max(1, stops.length * 2);
  let doneUnits = 0;
  let warningCount = 0;
  let audioReadyCount = 0;
  let lastWarning = "";

  const updateProgress = async (
    status:
      | "queued"
      | "generating_script"
      | "generating_audio"
      | "ready"
      | "ready_with_warnings"
      | "failed",
    message: string
  ) => {
    const progress = Math.min(99, Math.floor((doneUnits / totalUnits) * 100));
    await admin
      .from("mix_generation_jobs")
      .update({ status, message, progress })
      .eq("id", jobId);
  };

  type RowState = {
    stop: PreparedCustomRouteStop;
    canonicalStopId: string;
    baseScript: string | null;
    routeScript: string | null;
    audioUrl: string | null;
    usesFinalPrefilledScript: boolean;
  };
  const states: RowState[] = [];

  await updateProgress("generating_script", "Generating scripts");
  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i];
    const canonical = await ensureCanonicalStopForCustom(admin, city, stop);

    await upsertRouteStopMapping(admin, "custom", routeId, stop.id, canonical.id, i);

    const { data: assetRow } = !isCustomNarrator
      ? await admin
          .from("canonical_stop_assets")
          .select("script,audio_url")
          .eq("canonical_stop_id", canonical.id)
          .eq("persona", persona)
          .maybeSingle()
      : { data: null };

    const prefilledScript = normalizePrefilledScript(stop.prefilledScript);
    const usesFinalPrefilledScript = shouldTreatPrefilledScriptAsFinal(
      experienceKind,
      stop.prefilledScript
    );
    let script =
      usesFinalPrefilledScript
        ? prefilledScript
        : !forceScript && !isCustomNarrator
        ? toNullableTrimmed(assetRow?.script)
        : null;
    if (!forceScript && !script) {
      script = prefilledScript;
    }
    if (!script) {
      try {
        script = toNullableTrimmed(
          await generateScriptWithOpenAI(
            apiKey,
            city,
            transportMode,
            lengthMinutes,
            persona,
            stop,
            i,
            stops.length,
            narratorGuidance,
            { endingStyle: "reflective_close" }
          )
        );
      } catch (e) {
        warningCount += 1;
        lastWarning = `Script generation failed for ${persona} at stop "${stop.title}": ${
          e instanceof Error ? e.message : "Unknown error"
        }`;
      }
    }

    const scriptPatch = SCRIPT_PATCH_BY_PERSONA[persona](script);
    await admin
      .from("custom_route_stops")
      .update(scriptPatch)
      .eq("route_id", routeId)
      .eq("stop_id", stop.id);

    if (!isCustomNarrator && !usesFinalPrefilledScript) {
      await admin.from("canonical_stop_assets").upsert(
        {
          canonical_stop_id: canonical.id,
          persona,
          script,
          audio_url: toNullableAudioUrl(assetRow?.audio_url),
          status: script ? "ready" : "failed",
          error: script ? null : lastWarning || "Script generation failed",
        },
        { onConflict: "canonical_stop_id,persona" }
      );
    }

    states.push({
      stop,
      canonicalStopId: canonical.id,
      baseScript: script,
      routeScript: script,
      audioUrl: null,
      usesFinalPrefilledScript,
    });
    doneUnits += 1;
    await updateProgress(
      "generating_script",
      `Generating scripts (${doneUnits}/${totalUnits})`
    );
  }

  const harmonized = await harmonizeMixedRouteStopScripts({
    experienceKind,
    persona,
    narratorGuidance,
    stops,
    scripts: states.map((state) => state.routeScript),
    rewriteScriptOpener: async ({
      stop,
      script,
      openerFamily,
      blockedLeadIns,
    }) =>
      await rewriteScriptOpenerWithOpenAI(
        apiKey,
        city,
        transportMode,
        lengthMinutes,
        persona,
        stop,
        script,
        narratorGuidance,
        {
          routeContextMode: "mixed",
          openerFamily,
          blockedLeadIns,
        }
      ),
  });
  warningCount += harmonized.warningCount;
  if (harmonized.lastWarning) lastWarning = harmonized.lastWarning;

  for (let index = 0; index < states.length; index += 1) {
    const state = states[index];
    if (!state) continue;
    state.routeScript = toNullableTrimmed(harmonized.scripts[index]) || state.routeScript;

    const scriptPatch = SCRIPT_PATCH_BY_PERSONA[persona](state.routeScript);
    await admin
      .from("custom_route_stops")
      .update(scriptPatch)
      .eq("route_id", routeId)
      .eq("stop_id", state.stop.id);
  }

  await updateProgress("generating_audio", "Generating audio");
  for (const state of states) {
    const replayUrl = toNullableAudioUrl(
      switchConfig.replay_audio[state.stop.id]?.[persona]
    );
    const { data: assetRow } = !isCustomNarrator
      ? await admin
          .from("canonical_stop_assets")
          .select("script,audio_url")
          .eq("canonical_stop_id", state.canonicalStopId)
          .eq("persona", persona)
          .maybeSingle()
      : { data: null };

    const currentScript = toNullableTrimmed(state.routeScript);
    const canonicalScript =
      toNullableTrimmed(assetRow?.script) ||
      (state.usesFinalPrefilledScript ? null : toNullableTrimmed(state.baseScript));
    const hasRouteSpecificScript =
      experienceKind === "mix" &&
      Boolean(currentScript) &&
      currentScript !== canonicalScript;
    const shouldReuseCanonicalAudio = shouldReuseCanonicalAudioForRouteScript({
      experienceKind,
      isCustomNarrator,
      forceAudio,
      currentScript,
      canonicalScript,
    });
    let audioUrl =
      shouldReuseCanonicalAudio
        ? toNullableAudioUrl(assetRow?.audio_url)
        : null;
    if (replayUrl) audioUrl = replayUrl;

    if (!audioUrl && currentScript) {
      try {
        const audioBytes = await synthesizeSpeechWithOpenAI(
          apiKey,
          persona,
          currentScript,
          narratorVoice
        );
        audioUrl = toNullableAudioUrl(
          await uploadNarrationAudio(
            audioBytes,
            `custom-${routeId}`,
            persona,
            state.stop.id
          )
        );
      } catch (e) {
        warningCount += 1;
        lastWarning = `Audio generation failed for ${persona} at stop "${state.stop.title}": ${
          e instanceof Error ? e.message : "Unknown error"
        }`;
      }
    } else if (!audioUrl && !currentScript) {
      warningCount += 1;
      lastWarning = `Audio generation skipped for ${persona} at stop "${state.stop.title}" because script is missing`;
    }

    if (isUsableGeneratedAudioUrl(audioUrl)) audioReadyCount += 1;

    if (!isCustomNarrator && !hasRouteSpecificScript) {
      await admin.from("canonical_stop_assets").upsert(
        {
          canonical_stop_id: state.canonicalStopId,
          persona,
          script: canonicalScript,
          audio_url: audioUrl,
          status: audioUrl ? "ready" : "failed",
          error: audioUrl ? null : lastWarning || "Audio generation failed",
        },
        { onConflict: "canonical_stop_id,persona" }
      );
    }

    const audioPatch = AUDIO_PATCH_BY_PERSONA[persona](audioUrl);
    await admin
      .from("custom_route_stops")
      .update(audioPatch)
      .eq("route_id", routeId)
      .eq("stop_id", state.stop.id);

    doneUnits += 1;
    await updateProgress(
      "generating_audio",
      `Generating audio (${doneUnits}/${totalUnits})`
    );
  }

  if (audioReadyCount === 0) {
    throw new Error(lastWarning || `Audio generation failed for persona ${persona}.`);
  }

  await admin.from("custom_routes").update({ status: "ready" }).eq("id", routeId);
  await finalizeCustomRoutePublication(admin, routeId);
  if (warningCount > 0) {
    const warning = `${warningCount} generation warnings. ${lastWarning || ""}`.trim();
    await admin
      .from("mix_generation_jobs")
      .update({
        status: "ready_with_warnings",
        progress: 100,
        message: "Tour ready with warnings",
        error: warning,
      })
      .eq("id", jobId);
    return;
  }

  await admin
    .from("mix_generation_jobs")
    .update({ status: "ready", progress: 100, message: "Tour ready", error: null })
    .eq("id", jobId);
}
