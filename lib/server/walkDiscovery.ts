import type { SupabaseClient } from "@supabase/supabase-js";
import { getRouteById, type Persona } from "@/app/content/salemRoutes";
import {
  ensureCanonicalStopForCustom,
  ensureCanonicalStopForNearby,
  ensureCanonicalStopForPreset,
  upsertRouteStopMapping,
} from "@/lib/canonicalStops";
import {
  generateScriptWithOpenAI,
  selectCustomNarratorVoice,
  synthesizeSpeechWithOpenAI,
  toCustomNarratorVoice,
  toNullableAudioUrl,
  toNullableTrimmed,
  uploadNarrationAudio,
} from "@/lib/mixGeneration";
import type { NearbyPlaceCandidate } from "@/lib/nearbyPlaceResolver";
import { buildPresetStopsWithOverview, normalizePresetCity } from "@/lib/presetOverview";
import {
  buildGooglePlaceIdPhotoUrl,
  isValidGooglePlaceId,
  proxyGoogleImageUrl,
} from "@/lib/placesImages";

export type DiscoveryExperienceKind = "mix" | "walk_discovery";

type JamRow = {
  id: string;
  route_id: string | null;
};

type CanonicalAssetRow = {
  canonical_stop_id: string;
  persona: Persona;
  script: string | null;
  audio_url: string | null;
};

type CanonicalImageRow = {
  id: string;
  image_url: string | null;
  fallback_image_url: string | null;
  image_source: "places" | "curated" | "placeholder" | "link_seed" | null;
  google_place_id: string | null;
};

export type JourneyRouteStop = {
  stopId: string;
  title: string;
  lat: number;
  lng: number;
  googlePlaceId: string | null;
  imageUrl: string;
  scriptAdult: string | null;
  scriptPreteen: string | null;
  scriptGhost: string | null;
  scriptCustom: string | null;
  audioAdult: string | null;
  audioPreteen: string | null;
  audioGhost: string | null;
  audioCustom: string | null;
  canonicalStopId: string | null;
};

type RouteContext = {
  jamId: string;
  currentStops: JourneyRouteStop[];
  city: string;
  routeTitle: string;
  lengthMinutes: number;
  customRouteId: string | null;
  narratorGuidance: string | null;
  narratorVoice: ReturnType<typeof toCustomNarratorVoice>;
  experienceKind: DiscoveryExperienceKind;
};

type CanonicalPersonaAssets = {
  script: string | null;
  audio: string | null;
};

export type AcceptedNearbyStopResult = {
  routeId: string;
  routeRef: string;
  insertedStopId: string;
  insertedStopIndex: number;
  source: string;
  distanceMeters: number | null;
  reusedScript: boolean;
  reusedAudio: boolean;
};

function parseMinutes(value: string) {
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 30;
}

function buildUniqueStopId(existingIds: Set<string>, base: string) {
  const normalizedBase =
    base
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "nearby-stop";
  if (!existingIds.has(normalizedBase)) return normalizedBase;

  let idx = 2;
  while (existingIds.has(`${normalizedBase}-${idx}`)) idx += 1;
  return `${normalizedBase}-${idx}`;
}

function isNonPlaceholderImage(value: string | null | undefined) {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return false;
  return !normalized.toLowerCase().includes("/placeholder");
}

export function resolveJourneyRouteStopImage(args: {
  canonicalImage?: string | null;
  curatedFallback?: string | null;
  stopImage?: string | null;
  googlePlaceId?: string | null;
  canonicalSource?: CanonicalImageRow["image_source"];
  placeholder?: string;
}) {
  const placeholder = args.placeholder || "/images/salem/placeholder.png";
  const googlePlaceId = toNullableTrimmed(args.googlePlaceId);
  const placeIdPhoto = isValidGooglePlaceId(googlePlaceId)
    ? buildGooglePlaceIdPhotoUrl(googlePlaceId!.trim())
    : null;
  const preferStopSpecific =
    args.canonicalSource === "places" &&
    isNonPlaceholderImage(args.stopImage) &&
    isNonPlaceholderImage(args.canonicalImage);
  const rankedCandidates = preferStopSpecific
    ? [args.stopImage, args.canonicalImage, placeIdPhoto, args.curatedFallback]
    : [args.canonicalImage, placeIdPhoto, args.curatedFallback, args.stopImage];
  const strongCandidates = rankedCandidates
    .map((value) => toNullableTrimmed(value))
    .filter((value): value is string => Boolean(value) && isNonPlaceholderImage(value));

  return proxyGoogleImageUrl(strongCandidates[0] || args.stopImage || placeholder) || placeholder;
}

export type AcceptedNearbyStopSnapshot = {
  title: string;
  lat: number;
  lng: number;
  imageUrl: string;
  googlePlaceId: string | null;
};

export function buildAcceptedNearbyStopSnapshot(
  candidate: NearbyPlaceCandidate,
  canonicalImageUrl?: string | null
): AcceptedNearbyStopSnapshot {
  return {
    title: candidate.title,
    lat: candidate.lat,
    lng: candidate.lng,
    imageUrl:
      proxyGoogleImageUrl(canonicalImageUrl || candidate.image) ||
      "/images/salem/placeholder.png",
    googlePlaceId: toNullableTrimmed(candidate.googlePlaceId) ?? null,
  };
}

export function buildAcceptedNearbyRouteStop(args: {
  stopId: string;
  snapshot: AcceptedNearbyStopSnapshot;
  persona: Persona;
  selectedScript: string | null;
  selectedAudio: string | null;
  canonicalAssets: {
    scriptAdult: string | null;
    scriptPreteen: string | null;
    scriptGhost: string | null;
    audioAdult: string | null;
    audioPreteen: string | null;
    audioGhost: string | null;
  };
  canonicalStopId: string;
}): JourneyRouteStop {
  return {
    stopId: args.stopId,
    title: args.snapshot.title,
    lat: args.snapshot.lat,
    lng: args.snapshot.lng,
    googlePlaceId: args.snapshot.googlePlaceId,
    imageUrl: args.snapshot.imageUrl,
    scriptAdult:
      args.persona === "adult" ? args.selectedScript : args.canonicalAssets.scriptAdult,
    scriptPreteen:
      args.persona === "preteen"
        ? args.selectedScript
        : args.canonicalAssets.scriptPreteen,
    scriptGhost:
      args.persona === "ghost" ? args.selectedScript : args.canonicalAssets.scriptGhost,
    scriptCustom: args.persona === "custom" ? args.selectedScript : null,
    audioAdult:
      args.persona === "adult" ? args.selectedAudio : args.canonicalAssets.audioAdult,
    audioPreteen:
      args.persona === "preteen" ? args.selectedAudio : args.canonicalAssets.audioPreteen,
    audioGhost:
      args.persona === "ghost" ? args.selectedAudio : args.canonicalAssets.audioGhost,
    audioCustom: args.persona === "custom" ? args.selectedAudio : null,
    canonicalStopId: args.canonicalStopId,
  };
}

function mapAssetsByCanonical(rows: CanonicalAssetRow[]) {
  const byCanonical = new Map<
    string,
    {
      scriptAdult: string | null;
      scriptPreteen: string | null;
      scriptGhost: string | null;
      audioAdult: string | null;
      audioPreteen: string | null;
      audioGhost: string | null;
    }
  >();

  for (const row of rows) {
    const entry = byCanonical.get(row.canonical_stop_id) ?? {
      scriptAdult: null,
      scriptPreteen: null,
      scriptGhost: null,
      audioAdult: null,
      audioPreteen: null,
      audioGhost: null,
    };
    const script = toNullableTrimmed(row.script);
    const audioUrl = toNullableAudioUrl(row.audio_url);
    if (row.persona === "adult") {
      entry.scriptAdult = script;
      entry.audioAdult = audioUrl;
    } else if (row.persona === "preteen") {
      entry.scriptPreteen = script;
      entry.audioPreteen = audioUrl;
    } else {
      entry.scriptGhost = script;
      entry.audioGhost = audioUrl;
    }
    byCanonical.set(row.canonical_stop_id, entry);
  }

  return byCanonical;
}

function getCanonicalAssetsForPersona(
  persona: Persona,
  canonicalAssets: {
    scriptAdult: string | null;
    scriptPreteen: string | null;
    scriptGhost: string | null;
    audioAdult: string | null;
    audioPreteen: string | null;
    audioGhost: string | null;
  }
): CanonicalPersonaAssets {
  if (persona === "adult") {
    return {
      script: canonicalAssets.scriptAdult,
      audio: canonicalAssets.audioAdult,
    };
  }
  if (persona === "preteen") {
    return {
      script: canonicalAssets.scriptPreteen,
      audio: canonicalAssets.audioPreteen,
    };
  }
  if (persona === "ghost") {
    return {
      script: canonicalAssets.scriptGhost,
      audio: canonicalAssets.audioGhost,
    };
  }
  return {
    script: null,
    audio: null,
  };
}

async function loadCustomRouteStops(
  admin: SupabaseClient,
  routeId: string
): Promise<JourneyRouteStop[]> {
  const { data: stops, error: stopsErr } = await admin
    .from("custom_route_stops")
    .select(
      "stop_id,title,lat,lng,image_url,position,script_adult,script_preteen,script_ghost,script_custom,audio_url_adult,audio_url_preteen,audio_url_ghost,audio_url_custom"
    )
    .eq("route_id", routeId)
    .order("position", { ascending: true });
  if (stopsErr) throw new Error(stopsErr.message);

  const { data: mappings, error: mapErr } = await admin
    .from("route_stop_mappings")
    .select("stop_id,canonical_stop_id")
    .eq("route_kind", "custom")
    .eq("route_id", routeId);
  if (mapErr) throw new Error(mapErr.message);

  const mappingByStopId = new Map<string, string>();
  for (const row of mappings ?? []) {
    mappingByStopId.set(
      (row as { stop_id: string }).stop_id,
      (row as { canonical_stop_id: string }).canonical_stop_id
    );
  }

  const canonicalIds = Array.from(new Set(mappingByStopId.values()));
  const canonicalById = new Map<string, CanonicalImageRow>();
  if (canonicalIds.length > 0) {
    const { data: canonicalRows, error: canonicalErr } = await admin
      .from("canonical_stops")
      .select("id,image_url,fallback_image_url,image_source,google_place_id")
      .in("id", canonicalIds);
    if (canonicalErr) throw new Error(canonicalErr.message);

    for (const row of canonicalRows ?? []) {
      const typedRow = row as CanonicalImageRow;
      canonicalById.set(typedRow.id, typedRow);
    }
  }

  return (stops ?? []).map((stop) => {
    const canonical = canonicalById.get(mappingByStopId.get(stop.stop_id) ?? "");
    return {
      stopId: stop.stop_id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      googlePlaceId: toNullableTrimmed(canonical?.google_place_id),
      imageUrl: resolveJourneyRouteStopImage({
        canonicalImage: canonical?.image_url,
        curatedFallback: canonical?.fallback_image_url,
        stopImage: stop.image_url,
        googlePlaceId: canonical?.google_place_id,
        canonicalSource: canonical?.image_source ?? null,
      }),
      scriptAdult: toNullableTrimmed(stop.script_adult),
      scriptPreteen: toNullableTrimmed(stop.script_preteen),
      scriptGhost: toNullableTrimmed(stop.script_ghost),
      scriptCustom: toNullableTrimmed(stop.script_custom),
      audioAdult: toNullableAudioUrl(stop.audio_url_adult),
      audioPreteen: toNullableAudioUrl(stop.audio_url_preteen),
      audioGhost: toNullableAudioUrl(stop.audio_url_ghost),
      audioCustom: toNullableAudioUrl(stop.audio_url_custom),
      canonicalStopId: mappingByStopId.get(stop.stop_id) ?? null,
    };
  });
}

async function loadPresetRouteStops(
  admin: SupabaseClient,
  routeId: string,
  city: "salem" | "boston" | "concord" | "nyc"
): Promise<{ stops: JourneyRouteStop[]; title: string; lengthMinutes: number }> {
  const route = getRouteById(routeId);
  if (!route) throw new Error("Unknown preset route");
  const presetStops = buildPresetStopsWithOverview(
    route.stops,
    city,
    route.contentPriority
  );

  const { data: mapRows, error: mapErr } = await admin
    .from("route_stop_mappings")
    .select("stop_id,canonical_stop_id")
    .eq("route_kind", "preset")
    .eq("route_id", routeId);
  if (mapErr) throw new Error(mapErr.message);

  const mappingByStopId = new Map<string, string>();
  for (const row of mapRows ?? []) {
    mappingByStopId.set(
      (row as { stop_id: string }).stop_id,
      (row as { canonical_stop_id: string }).canonical_stop_id
    );
  }

  for (const stop of presetStops) {
    if (mappingByStopId.has(stop.id)) continue;
    const canonical = await ensureCanonicalStopForPreset(admin, city, route.id, {
      id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: stop.image,
    });
    mappingByStopId.set(stop.id, canonical.id);
    await upsertRouteStopMapping(
      admin,
      "preset",
      route.id,
      stop.id,
      canonical.id,
      presetStops.findIndex((candidate) => candidate.id === stop.id)
    );
  }

  const canonicalIds = Array.from(new Set(mappingByStopId.values()));
  const { data: assetsRows, error: assetErr } = canonicalIds.length
    ? await admin
        .from("canonical_stop_assets")
        .select("canonical_stop_id,persona,script,audio_url")
        .in("canonical_stop_id", canonicalIds)
    : { data: [], error: null };
  if (assetErr) throw new Error(assetErr.message);
  const assetsByCanonical = mapAssetsByCanonical(
    (assetsRows ?? []) as CanonicalAssetRow[]
  );

  const { data: canonicalRows, error: canonErr } = canonicalIds.length
    ? await admin
        .from("canonical_stops")
        .select("id,image_url,fallback_image_url,image_source,google_place_id")
        .in("id", canonicalIds)
    : { data: [], error: null };
  if (canonErr) throw new Error(canonErr.message);
  const canonicalById = new Map<string, CanonicalImageRow>();
  for (const row of canonicalRows ?? []) {
    const typedRow = row as CanonicalImageRow;
    canonicalById.set(typedRow.id, typedRow);
  }

  return {
    title: route.title,
    lengthMinutes: parseMinutes(route.durationLabel),
    stops: presetStops.map((stop) => {
      const canonicalId = mappingByStopId.get(stop.id) ?? null;
      const assets = canonicalId ? assetsByCanonical.get(canonicalId) : null;
      const canonical = canonicalId ? canonicalById.get(canonicalId) : null;

      return {
        stopId: stop.id,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        googlePlaceId: toNullableTrimmed(stop.googlePlaceId) ?? toNullableTrimmed(canonical?.google_place_id),
        imageUrl: resolveJourneyRouteStopImage({
          canonicalImage: canonical?.image_url,
          curatedFallback: canonical?.fallback_image_url,
          stopImage: stop.image,
          googlePlaceId: stop.googlePlaceId ?? canonical?.google_place_id,
          canonicalSource: canonical?.image_source ?? null,
        }),
        scriptAdult: assets?.scriptAdult ?? null,
        scriptPreteen: assets?.scriptPreteen ?? null,
        scriptGhost: assets?.scriptGhost ?? null,
        scriptCustom: null,
        audioAdult: assets?.audioAdult ?? null,
        audioPreteen: assets?.audioPreteen ?? null,
        audioGhost: assets?.audioGhost ?? null,
        audioCustom: null,
        canonicalStopId: canonicalId,
      };
    }),
  };
}

async function resolveRouteContext(
  admin: SupabaseClient,
  jamId: string,
  cityHint?: "salem" | "boston" | "concord" | "nyc" | null
): Promise<RouteContext> {
  const { data: jam, error: jamErr } = await admin
    .from("jams")
    .select("id,route_id")
    .eq("id", jamId)
    .single();
  if (jamErr || !jam) {
    throw new Error(jamErr?.message || "Jam not found.");
  }

  const jamRow = jam as JamRow;
  let city = normalizePresetCity(cityHint);
  let currentStops: JourneyRouteStop[] = [];
  let routeTitle = "Wander";
  let lengthMinutes = 30;
  let customRouteId: string | null = null;
  let narratorGuidance: string | null = null;
  let narratorVoice: ReturnType<typeof toCustomNarratorVoice> = null;
  let experienceKind: DiscoveryExperienceKind = "mix";

  if (!jamRow.route_id) {
    return {
      jamId,
      currentStops,
      city,
      routeTitle,
      lengthMinutes,
      customRouteId,
      narratorGuidance,
      narratorVoice,
      experienceKind,
    };
  }

  if (jamRow.route_id.startsWith("custom:")) {
    customRouteId = jamRow.route_id.slice("custom:".length) || null;
    if (!customRouteId) throw new Error("Invalid custom route reference.");

    const { data: routeMeta, error: routeMetaErr } = await admin
      .from("custom_routes")
      .select(
        "id,title,length_minutes,city,narrator_guidance,narrator_voice,experience_kind"
      )
      .eq("id", customRouteId)
      .single();
    if (routeMetaErr || !routeMeta) {
      throw new Error(routeMetaErr?.message || "Custom route not found.");
    }

    city = normalizePresetCity(
      routeMeta.city as "salem" | "boston" | "concord" | "nyc" | null
    );
    currentStops = await loadCustomRouteStops(admin, customRouteId);
    routeTitle = routeMeta.title || routeTitle;
    lengthMinutes = routeMeta.length_minutes || lengthMinutes;
    narratorGuidance = toNullableTrimmed(routeMeta.narrator_guidance);
    narratorVoice = toCustomNarratorVoice(routeMeta.narrator_voice);
    experienceKind =
      routeMeta.experience_kind === "walk_discovery"
        ? "walk_discovery"
        : "mix";
  } else {
    const presetRoute = getRouteById(jamRow.route_id);
    if (presetRoute?.city) {
      city = presetRoute.city;
    }
    const preset = await loadPresetRouteStops(admin, jamRow.route_id, city);
    currentStops = preset.stops;
    routeTitle = preset.title;
    lengthMinutes = preset.lengthMinutes;
  }

  return {
    jamId,
    currentStops,
    city,
    routeTitle,
    lengthMinutes,
    customRouteId,
    narratorGuidance,
    narratorVoice,
    experienceKind,
  };
}

export async function loadJourneyRouteStopsForWalkDiscovery(
  admin: SupabaseClient,
  jamId: string,
  cityHint?: "salem" | "boston" | "concord" | "nyc" | null
) {
  const context = await resolveRouteContext(admin, jamId, cityHint);
  return context.currentStops;
}

export async function createDiscoveryJam(
  admin: SupabaseClient,
  persona: Persona
) {
  const { data, error } = await admin
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
  if (error || !data?.id) {
    throw new Error(error?.message || "Failed to create jam.");
  }
  return data.id as string;
}

export async function appendAcceptedNearbyStop(args: {
  admin: SupabaseClient;
  jamId: string;
  persona: Persona;
  candidate: NearbyPlaceCandidate;
  city?: "salem" | "boston" | "concord" | "nyc" | null;
  insertAfterStopIndex?: number | null;
  routeTitle?: string | null;
  experienceKind?: DiscoveryExperienceKind;
  generateAssets?: boolean;
}) {
  const context = await resolveRouteContext(args.admin, args.jamId, args.city);
  const city = context.city;
  let customRouteId = context.customRouteId;
  const narratorGuidance = context.narratorGuidance;
  let narratorVoice = context.narratorVoice;

  if (args.persona === "custom" && !narratorGuidance) {
    throw new Error("Narrator guidance is required for custom narrator tours.");
  }
  if (args.persona === "custom" && !narratorVoice && narratorGuidance) {
    narratorVoice = selectCustomNarratorVoice(narratorGuidance);
  }

  const canonical = await ensureCanonicalStopForNearby(args.admin, city, {
    id: args.candidate.id,
    title: args.candidate.title,
    lat: args.candidate.lat,
    lng: args.candidate.lng,
    image: args.candidate.image,
    googlePlaceId: args.candidate.googlePlaceId ?? undefined,
  });
  const acceptedSnapshot = buildAcceptedNearbyStopSnapshot(
    args.candidate,
    canonical.image_url || null
  );

  const { data: existingAssetsRows, error: existingAssetsErr } =
    args.persona !== "custom"
      ? await args.admin
          .from("canonical_stop_assets")
          .select("canonical_stop_id,persona,script,audio_url")
          .eq("canonical_stop_id", canonical.id)
      : { data: [], error: null };
  if (existingAssetsErr) throw new Error(existingAssetsErr.message);

  const assetsByCanonical = mapAssetsByCanonical(
    (existingAssetsRows ?? []) as CanonicalAssetRow[]
  );
  const canonicalAssets = assetsByCanonical.get(canonical.id) ?? {
    scriptAdult: null,
    scriptPreteen: null,
    scriptGhost: null,
    audioAdult: null,
    audioPreteen: null,
    audioGhost: null,
  };

  let selectedScript: string | null = null;
  let selectedAudio: string | null = null;
  const personaAssets = getCanonicalAssetsForPersona(args.persona, canonicalAssets);
  selectedScript = personaAssets.script;
  selectedAudio = personaAssets.audio;
  let reusedScript = Boolean(selectedScript);
  let reusedAudio = Boolean(selectedAudio);
  reusedScript = Boolean(selectedScript);
  reusedAudio = Boolean(selectedAudio);

  const shouldGenerateAssets = args.generateAssets !== false;
  const apiKey = shouldGenerateAssets ? process.env.OPENAI_API_KEY?.trim() : null;
  const insertedStopIndex =
    typeof args.insertAfterStopIndex === "number" &&
    Number.isFinite(args.insertAfterStopIndex)
      ? Math.max(
          0,
          Math.min(context.currentStops.length, Math.trunc(args.insertAfterStopIndex) + 1)
        )
      : context.currentStops.length;

  if (shouldGenerateAssets && !selectedScript) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required to generate narration.");
    }
    selectedScript = toNullableTrimmed(
      await generateScriptWithOpenAI(
        apiKey,
        city,
        "walk",
        context.lengthMinutes,
        args.persona,
        {
          id: canonical.id,
          title: acceptedSnapshot.title,
          lat: acceptedSnapshot.lat,
          lng: acceptedSnapshot.lng,
          image: acceptedSnapshot.imageUrl,
          googlePlaceId: acceptedSnapshot.googlePlaceId ?? undefined,
        },
        insertedStopIndex,
        Math.max(1, context.currentStops.length + 1),
        narratorGuidance,
        { endingStyle: "reflective_close" }
      )
    );
    if (!selectedScript) {
      throw new Error("Generated script was empty.");
    }
  }

  if (shouldGenerateAssets && !selectedAudio) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required to generate narration audio.");
    }
    if (!selectedScript) {
      throw new Error("Narration script is required before audio generation.");
    }
    const audioBytes = await synthesizeSpeechWithOpenAI(
      apiKey,
      args.persona,
      selectedScript,
      narratorVoice
    );
    selectedAudio = toNullableAudioUrl(
      await uploadNarrationAudio(
        audioBytes,
        `nearby-${context.jamId}`,
        args.persona,
        canonical.id
      )
    );
    if (!selectedAudio) {
      throw new Error("Generated audio URL was empty.");
    }
  }

  if (shouldGenerateAssets && args.persona !== "custom") {
    await args.admin.from("canonical_stop_assets").upsert(
      {
        canonical_stop_id: canonical.id,
        persona: args.persona,
        script: selectedScript,
        audio_url: selectedAudio,
        status: "ready",
        error: null,
      },
      { onConflict: "canonical_stop_id,persona" }
    );
  }

  const existingIds = new Set(context.currentStops.map((stop) => stop.stopId));
  const nearbyStopId = buildUniqueStopId(
    existingIds,
    `nearby-${canonical.id}`
  );

  const insertedStop = buildAcceptedNearbyRouteStop({
    stopId: nearbyStopId,
    snapshot: acceptedSnapshot,
    persona: args.persona,
    selectedScript,
    selectedAudio,
    canonicalAssets,
    canonicalStopId: canonical.id,
  });

  const nextStops = [...context.currentStops];
  nextStops.splice(insertedStopIndex, 0, insertedStop);

  if (!customRouteId) {
    const { data: existingCustom, error: existingCustomErr } = await args.admin
      .from("custom_routes")
      .select("id")
      .eq("jam_id", context.jamId)
      .maybeSingle();
    if (existingCustomErr) throw new Error(existingCustomErr.message);
    customRouteId = existingCustom?.id ?? null;
  }

  const routePatch = {
    city,
    transport_mode: "walk",
    length_minutes: context.lengthMinutes,
    title: toNullableTrimmed(args.routeTitle) || context.routeTitle,
    narrator_default: args.persona,
    narrator_guidance: narratorGuidance,
    narrator_voice: args.persona === "custom" ? narratorVoice : null,
    status: "ready",
    experience_kind: args.experienceKind ?? context.experienceKind,
  };

  if (customRouteId) {
    const { error: updateErr } = await args.admin
      .from("custom_routes")
      .update(routePatch)
      .eq("id", customRouteId);
    if (updateErr) throw new Error(updateErr.message);
  } else {
    const { data: createdRoute, error: createRouteErr } = await args.admin
      .from("custom_routes")
      .insert({
        jam_id: context.jamId,
        ...routePatch,
      })
      .select("id")
      .single();
    if (createRouteErr || !createdRoute?.id) {
      throw new Error(
        createRouteErr?.message || "Failed to create custom route."
      );
    }
    customRouteId = createdRoute.id;
  }

  if (!customRouteId) throw new Error("Failed to resolve custom route id.");

  const { error: deleteStopsErr } = await args.admin
    .from("custom_route_stops")
    .delete()
    .eq("route_id", customRouteId);
  if (deleteStopsErr) throw new Error(deleteStopsErr.message);

  const { error: deleteMappingsErr } = await args.admin
    .from("route_stop_mappings")
    .delete()
    .eq("route_kind", "custom")
    .eq("route_id", customRouteId);
  if (deleteMappingsErr) throw new Error(deleteMappingsErr.message);

  const stopInserts = nextStops.map((stop, position) => ({
    route_id: customRouteId,
    stop_id: stop.stopId,
    position,
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    image_url: stop.imageUrl,
    script_adult: stop.scriptAdult,
    script_preteen: stop.scriptPreteen,
    script_ghost: stop.scriptGhost,
    script_custom: stop.scriptCustom,
    audio_url_adult: stop.audioAdult,
    audio_url_preteen: stop.audioPreteen,
    audio_url_ghost: stop.audioGhost,
    audio_url_custom: stop.audioCustom,
  }));
  const { error: insertStopsErr } = await args.admin
    .from("custom_route_stops")
    .insert(stopInserts);
  if (insertStopsErr) throw new Error(insertStopsErr.message);

  for (let idx = 0; idx < nextStops.length; idx += 1) {
    const stop = nextStops[idx];
    let canonicalStopId = stop.canonicalStopId;
    if (!canonicalStopId) {
      const ensured = await ensureCanonicalStopForCustom(args.admin, city, {
        id: stop.stopId,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        image: stop.imageUrl,
      });
      canonicalStopId = ensured.id;
    }
    await upsertRouteStopMapping(
      args.admin,
      "custom",
      customRouteId,
      stop.stopId,
      canonicalStopId,
      idx
    );
  }

  const { error: jamUpdateErr } = await args.admin
    .from("jams")
    .update({
      route_id: `custom:${customRouteId}`,
      current_stop: insertedStopIndex,
      persona: args.persona,
      completed_at: null,
    })
    .eq("id", context.jamId);
  if (jamUpdateErr) throw new Error(jamUpdateErr.message);

  return {
    routeId: customRouteId,
    routeRef: `custom:${customRouteId}`,
    insertedStopId: insertedStop.stopId,
    insertedStopIndex,
    source: args.candidate.source,
    distanceMeters: args.candidate.distanceMeters,
    reusedScript,
    reusedAudio,
  } satisfies AcceptedNearbyStopResult;
}
