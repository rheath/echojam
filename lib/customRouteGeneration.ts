import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ensureCanonicalStopForCustom,
  upsertRouteStopMapping,
} from "@/lib/canonicalStops";
import {
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
  validateMixSelection,
  type TransportMode,
} from "@/lib/mixConstraints";

export type CustomRouteExperienceKind = "mix" | "follow_along";
export type CustomRouteStopKind = "story" | "arrival";

export type PreparedCustomRouteStop = StopInput & {
  stopKind?: CustomRouteStopKind;
  distanceAlongRouteMeters?: number | null;
  triggerRadiusMeters?: number | null;
};

export type PrepareCustomRouteJobInput = {
  admin: SupabaseClient;
  jamId?: string | null;
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
};

export type PreparedCustomRouteJob = {
  jamId: string;
  routeId: string;
  routeRef: string;
  jobId: string;
  city: string;
  transportMode: TransportMode;
  lengthMinutes: number;
  persona: Persona;
  narratorGuidance: string | null;
  stops: PreparedCustomRouteStop[];
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

async function createJam(
  admin: SupabaseClient,
  persona: Persona
) {
  const { data: jam, error: jamErr } = await admin
    .from("jams")
    .insert({
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

export async function prepareCustomRouteJob(
  input: PrepareCustomRouteJobInput
): Promise<PreparedCustomRouteJob> {
  const city = (input.city || "").trim().toLowerCase() || "nearby";
  const narratorGuidance = toNullableTrimmed(input.narratorGuidance);
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
  if (input.persona === "custom" && !narratorGuidance) {
    throw new Error("Narrator guidance is required.");
  }

  let jamId = input.jamId ?? null;
  if (!jamId) {
    jamId = await createJam(input.admin, input.persona);
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
  const { data: existingRoute } = await input.admin
    .from("custom_routes")
    .select("id")
    .eq("jam_id", jamId)
    .maybeSingle();

  const routePatch = {
    city,
    transport_mode: input.transportMode,
    length_minutes: input.lengthMinutes,
    title: routeTitle,
    narrator_default: input.persona,
    narrator_guidance: narratorGuidance,
    narrator_voice:
      input.persona === "custom"
        ? input.narratorVoice ??
          (narratorGuidance ? selectCustomNarratorVoice(narratorGuidance) : null)
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
  };

  let routeId = existingRoute?.id as string | undefined;
  if (routeId) {
    const { error: updateRouteErr } = await input.admin
      .from("custom_routes")
      .update(routePatch)
      .eq("id", routeId);
    if (updateRouteErr) {
      throw new Error(
        updateRouteErr.message || "Failed to update custom route"
      );
    }
  } else {
    const { data: route, error: routeErr } = await input.admin
      .from("custom_routes")
      .insert({
        jam_id: jamId,
        ...routePatch,
      })
      .select("id")
      .single();
    if (routeErr || !route?.id) {
      throw new Error(routeErr?.message || "Failed to create custom route");
    }
    routeId = route.id as string;
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
      route_id: `custom:${routeId}`,
      persona: input.persona,
      current_stop: 0,
      completed_at: null,
      preset_id: null,
    })
    .eq("id", jamId);

  const inserts = input.stops.map((stop, idx) => ({
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
  }));
  const { error: stopsErr } = await input.admin
    .from("custom_route_stops")
    .insert(inserts);
  if (stopsErr) throw new Error(stopsErr.message);

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
    persona: input.persona,
    narratorGuidance,
    stops: input.stops,
  };
}

export async function runCustomRouteGeneration(
  admin: SupabaseClient,
  jobId: string,
  routeId: string,
  city: string,
  transportMode: TransportMode,
  lengthMinutes: number,
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
    script: string | null;
    audioUrl: string | null;
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

    let script =
      !forceScript && !isCustomNarrator
        ? toNullableTrimmed(assetRow?.script)
        : null;
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
            narratorGuidance
          )
        );
      } catch (e) {
        warningCount += 1;
        lastWarning = `Script generation failed for ${persona} at stop "${stop.title}": ${
          e instanceof Error ? e.message : "Unknown error"
        }`;
      }
    }

    if (!isCustomNarrator) {
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

    const scriptPatch = SCRIPT_PATCH_BY_PERSONA[persona](script);
    await admin
      .from("custom_route_stops")
      .update(scriptPatch)
      .eq("route_id", routeId)
      .eq("stop_id", stop.id);

    states.push({ stop, canonicalStopId: canonical.id, script, audioUrl: null });
    doneUnits += 1;
    await updateProgress(
      "generating_script",
      `Generating scripts (${doneUnits}/${totalUnits})`
    );
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

    const currentScript = isCustomNarrator
      ? state.script
      : toNullableTrimmed(assetRow?.script) || state.script;
    let audioUrl =
      !forceAudio && !isCustomNarrator
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

    if (!isCustomNarrator) {
      await admin.from("canonical_stop_assets").upsert(
        {
          canonical_stop_id: state.canonicalStopId,
          persona,
          script: currentScript,
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
