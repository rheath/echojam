import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById, type Persona } from "@/app/content/salemRoutes";
import {
  ensureCanonicalStopForCustom,
  ensureCanonicalStopForNearby,
  ensureCanonicalStopForPreset,
  upsertRouteStopMapping,
} from "@/lib/canonicalStops";
import {
  selectCustomNarratorVoice,
  generateScriptWithOpenAI,
  synthesizeSpeechWithOpenAI,
  toCustomNarratorVoice,
  toNullableAudioUrl,
  toNullableTrimmed,
  uploadNarrationAudio,
} from "@/lib/mixGeneration";
import { resolveNearbyPlace } from "@/lib/nearbyPlaceResolver";
import { buildPresetStopsWithOverview, normalizePresetCity } from "@/lib/presetOverview";
import { proxyGoogleImageUrl } from "@/lib/placesImages";

type Body = {
  jamId: string;
  persona: Persona;
  lat: number;
  lng: number;
  currentStopIndex: number | null;
  city?: "salem" | "boston" | "concord" | "nyc";
};

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

type RouteStop = {
  stopId: string;
  title: string;
  lat: number;
  lng: number;
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

function isEnabled(value: string | undefined) {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isNearbyStoryEnabled() {
  return isEnabled(process.env.ENABLE_NEARBY_STORY) || isEnabled(process.env.NEXT_PUBLIC_ENABLE_NEARBY_STORY);
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseMinutes(value: string) {
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 30;
}

function isFiniteCoord(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 180;
}

function buildUniqueStopId(existingIds: Set<string>, base: string) {
  const normalizedBase = base.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "nearby-stop";
  if (!existingIds.has(normalizedBase)) return normalizedBase;
  let idx = 2;
  while (existingIds.has(`${normalizedBase}-${idx}`)) idx += 1;
  return `${normalizedBase}-${idx}`;
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

async function loadCustomRouteStops(admin: ReturnType<typeof getAdmin>, routeId: string): Promise<RouteStop[]> {
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
    const stopId = (row as { stop_id: string }).stop_id;
    const canonicalId = (row as { canonical_stop_id: string }).canonical_stop_id;
    mappingByStopId.set(stopId, canonicalId);
  }

  return (stops ?? []).map((stop) => ({
    stopId: stop.stop_id,
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    imageUrl: proxyGoogleImageUrl(stop.image_url) || "/images/salem/placeholder.png",
    scriptAdult: toNullableTrimmed(stop.script_adult),
    scriptPreteen: toNullableTrimmed(stop.script_preteen),
    scriptGhost: toNullableTrimmed(stop.script_ghost),
    scriptCustom: toNullableTrimmed(stop.script_custom),
    audioAdult: toNullableAudioUrl(stop.audio_url_adult),
    audioPreteen: toNullableAudioUrl(stop.audio_url_preteen),
    audioGhost: toNullableAudioUrl(stop.audio_url_ghost),
    audioCustom: toNullableAudioUrl(stop.audio_url_custom),
    canonicalStopId: mappingByStopId.get(stop.stop_id) ?? null,
  }));
}

async function loadPresetRouteStops(
  admin: ReturnType<typeof getAdmin>,
  routeId: string,
  city: "salem" | "boston" | "concord" | "nyc"
): Promise<{ stops: RouteStop[]; title: string; lengthMinutes: number }> {
  const route = getRouteById(routeId);
  if (!route) throw new Error("Unknown preset route");
  const presetStops = buildPresetStopsWithOverview(route.stops, city);

  const { data: mapRows, error: mapErr } = await admin
    .from("route_stop_mappings")
    .select("stop_id,canonical_stop_id")
    .eq("route_kind", "preset")
    .eq("route_id", routeId);
  if (mapErr) throw new Error(mapErr.message);

  const mappingByStopId = new Map<string, string>();
  for (const row of mapRows ?? []) {
    mappingByStopId.set((row as { stop_id: string }).stop_id, (row as { canonical_stop_id: string }).canonical_stop_id);
  }

  for (const stop of presetStops) {
    if (mappingByStopId.has(stop.id)) continue;
    const canonical = await ensureCanonicalStopForPreset(admin, city, {
      id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: stop.image,
    });
    mappingByStopId.set(stop.id, canonical.id);
    await upsertRouteStopMapping(admin, "preset", route.id, stop.id, canonical.id, presetStops.findIndex((s) => s.id === stop.id));
  }

  const canonicalIds = Array.from(new Set(Array.from(mappingByStopId.values())));
  const { data: assetsRows, error: assetErr } = canonicalIds.length
    ? await admin
        .from("canonical_stop_assets")
        .select("canonical_stop_id,persona,script,audio_url")
        .in("canonical_stop_id", canonicalIds)
    : { data: [], error: null };
  if (assetErr) throw new Error(assetErr.message);
  const assetsByCanonical = mapAssetsByCanonical((assetsRows ?? []) as CanonicalAssetRow[]);

  const { data: canonicalRows, error: canonErr } = canonicalIds.length
    ? await admin.from("canonical_stops").select("id,image_url").in("id", canonicalIds)
    : { data: [], error: null };
  if (canonErr) throw new Error(canonErr.message);
  const imageByCanonical = new Map<string, string | null>();
  for (const row of canonicalRows ?? []) {
    imageByCanonical.set((row as { id: string }).id, (row as { image_url: string | null }).image_url);
  }

  const stops: RouteStop[] = presetStops.map((stop) => {
    const canonicalId = mappingByStopId.get(stop.id) ?? null;
    const assets = canonicalId ? assetsByCanonical.get(canonicalId) : null;
    const canonicalImage = canonicalId ? toNullableTrimmed(imageByCanonical.get(canonicalId) || null) : null;
    return {
      stopId: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      imageUrl: proxyGoogleImageUrl(canonicalImage || stop.image) || "/images/salem/placeholder.png",
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
  });

  return {
    stops,
    title: route.title,
    lengthMinutes: parseMinutes(route.durationLabel),
  };
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  if (!isNearbyStoryEnabled()) {
    return NextResponse.json({ error: "Nearby story feature is disabled." }, { status: 404 });
  }

  try {
    const body = (await req.json()) as Body;
    if (!body?.jamId || !body?.persona) {
      return NextResponse.json({ error: "jamId and persona are required." }, { status: 400 });
    }
    if (!isFiniteCoord(body.lat) || !isFiniteCoord(body.lng) || Math.abs(body.lat) > 90) {
      return NextResponse.json({ error: "Valid geolocation is required." }, { status: 400 });
    }

    const admin = getAdmin();
    const { data: jam, error: jamErr } = await admin
      .from("jams")
      .select("id,route_id")
      .eq("id", body.jamId)
      .single();
    if (jamErr || !jam) {
      return NextResponse.json({ error: jamErr?.message || "Jam not found." }, { status: 404 });
    }

    const jamRow = jam as JamRow;
    let city = normalizePresetCity(body.city);
    let currentStops: RouteStop[] = [];
    let routeTitle = "Nearby Story Mix";
    let lengthMinutes = 30;
    let customRouteId: string | null = null;
    let narratorGuidance: string | null = null;
    let narratorVoice: ReturnType<typeof toCustomNarratorVoice> = null;

    if (!jamRow.route_id) {
      // First-run instant flow starts with no route; use empty stops and defaults.
    } else if (jamRow.route_id.startsWith("custom:")) {
      customRouteId = jamRow.route_id.slice("custom:".length) || null;
      if (!customRouteId) return NextResponse.json({ error: "Invalid custom route reference." }, { status: 400 });
      const { data: routeMeta, error: routeMetaErr } = await admin
        .from("custom_routes")
        .select("id,title,length_minutes,city,narrator_guidance,narrator_default,narrator_voice")
        .eq("id", customRouteId)
        .single();
      if (routeMetaErr || !routeMeta) {
        return NextResponse.json({ error: routeMetaErr?.message || "Custom route not found." }, { status: 404 });
      }
      city = normalizePresetCity(routeMeta.city as "salem" | "boston" | "concord" | "nyc" | null);
      currentStops = await loadCustomRouteStops(admin, customRouteId);
      routeTitle = routeMeta.title || routeTitle;
      lengthMinutes = routeMeta.length_minutes || lengthMinutes;
      narratorGuidance = toNullableTrimmed(routeMeta.narrator_guidance);
      narratorVoice = toCustomNarratorVoice(routeMeta.narrator_voice);
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

    if (body.persona === "custom" && !narratorGuidance) {
      return NextResponse.json({ error: "Narrator guidance is required for custom narrator tours." }, { status: 400 });
    }
    if (body.persona === "custom" && !narratorVoice && narratorGuidance) {
      narratorVoice = selectCustomNarratorVoice(narratorGuidance);
    }

    const resolverStartedAt = Date.now();
    const resolved = await resolveNearbyPlace({
      admin,
      city,
      lat: body.lat,
      lng: body.lng,
      radiusMeters: 500,
    });
    const resolverMs = Date.now() - resolverStartedAt;

    if (!resolved.candidate) {
      if (resolved.missingGooglePlacesKey) {
        return NextResponse.json(
          {
            error: "No nearby canonical place found. Configure GOOGLE_PLACES_API_KEY to enable live nearby discovery.",
          },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "No nearby notable place found within 500 meters." },
        { status: 404 }
      );
    }

    const canonical = await ensureCanonicalStopForNearby(admin, city, {
      id: resolved.candidate.id,
      title: resolved.candidate.title,
      lat: resolved.candidate.lat,
      lng: resolved.candidate.lng,
      image: resolved.candidate.image,
      googlePlaceId: resolved.candidate.googlePlaceId ?? undefined,
    });

    const { data: existingAssetsRows, error: existingAssetsErr } = body.persona !== "custom"
      ? await admin
          .from("canonical_stop_assets")
          .select("canonical_stop_id,persona,script,audio_url")
          .eq("canonical_stop_id", canonical.id)
      : { data: [], error: null };
    if (existingAssetsErr) throw new Error(existingAssetsErr.message);

    const assetsByCanonical = mapAssetsByCanonical((existingAssetsRows ?? []) as CanonicalAssetRow[]);
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
    let reusedScript = false;
    let reusedAudio = false;
    if (body.persona === "adult") {
      selectedScript = canonicalAssets.scriptAdult;
      selectedAudio = canonicalAssets.audioAdult;
      reusedScript = Boolean(canonicalAssets.scriptAdult);
      reusedAudio = Boolean(canonicalAssets.audioAdult);
    } else if (body.persona === "preteen") {
      selectedScript = canonicalAssets.scriptPreteen;
      selectedAudio = canonicalAssets.audioPreteen;
      reusedScript = Boolean(canonicalAssets.scriptPreteen);
      reusedAudio = Boolean(canonicalAssets.audioPreteen);
    } else if (body.persona === "ghost") {
      selectedScript = canonicalAssets.scriptGhost;
      selectedAudio = canonicalAssets.audioGhost;
      reusedScript = Boolean(canonicalAssets.scriptGhost);
      reusedAudio = Boolean(canonicalAssets.audioGhost);
    }
    const apiKey = process.env.OPENAI_API_KEY?.trim();

    const currentStopIndex =
      typeof body.currentStopIndex === "number" && Number.isFinite(body.currentStopIndex)
        ? Math.max(-1, Math.min(currentStops.length - 1, Math.trunc(body.currentStopIndex)))
        : -1;
    const insertedStopIndex = Math.max(0, Math.min(currentStops.length, currentStopIndex + 1));

    if (!selectedScript) {
      if (!apiKey) {
        return NextResponse.json({ error: "OPENAI_API_KEY is required to generate narration." }, { status: 500 });
      }
      selectedScript = toNullableTrimmed(
        await generateScriptWithOpenAI(
          apiKey,
          city,
          "walk",
          lengthMinutes,
          body.persona,
          {
            id: canonical.id,
            title: canonical.title,
            lat: canonical.lat,
            lng: canonical.lng,
            image: proxyGoogleImageUrl(canonical.image_url || resolved.candidate.image) || "/images/salem/placeholder.png",
          },
          insertedStopIndex,
          Math.max(1, currentStops.length + 1),
          narratorGuidance
        )
      );
      if (!selectedScript) {
        return NextResponse.json({ error: "Generated script was empty." }, { status: 500 });
      }
    }

    if (!selectedAudio) {
      if (!apiKey) {
        return NextResponse.json({ error: "OPENAI_API_KEY is required to generate narration audio." }, { status: 500 });
      }
      const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, body.persona, selectedScript, narratorVoice);
      selectedAudio = toNullableAudioUrl(
        await uploadNarrationAudio(audioBytes, `nearby-${jamRow.id}`, body.persona, canonical.id)
      );
      if (!selectedAudio) {
        return NextResponse.json({ error: "Generated audio URL was empty." }, { status: 500 });
      }
    }

    if (body.persona !== "custom") {
      await admin.from("canonical_stop_assets").upsert(
        {
          canonical_stop_id: canonical.id,
          persona: body.persona,
          script: selectedScript,
          audio_url: selectedAudio,
          status: "ready",
          error: null,
        },
        { onConflict: "canonical_stop_id,persona" }
      );
    }

    const existingIds = new Set(currentStops.map((stop) => stop.stopId));
    const nearbyStopId = buildUniqueStopId(existingIds, `nearby-${canonical.id}`);

    const insertedStop: RouteStop = {
      stopId: nearbyStopId,
      title: canonical.title,
      lat: canonical.lat,
      lng: canonical.lng,
      imageUrl:
        proxyGoogleImageUrl(canonical.image_url || resolved.candidate.image) || "/images/salem/placeholder.png",
      scriptAdult: body.persona === "adult" ? selectedScript : canonicalAssets.scriptAdult,
      scriptPreteen: body.persona === "preteen" ? selectedScript : canonicalAssets.scriptPreteen,
      scriptGhost: body.persona === "ghost" ? selectedScript : canonicalAssets.scriptGhost,
      scriptCustom: body.persona === "custom" ? selectedScript : null,
      audioAdult: body.persona === "adult" ? selectedAudio : canonicalAssets.audioAdult,
      audioPreteen: body.persona === "preteen" ? selectedAudio : canonicalAssets.audioPreteen,
      audioGhost: body.persona === "ghost" ? selectedAudio : canonicalAssets.audioGhost,
      audioCustom: body.persona === "custom" ? selectedAudio : null,
      canonicalStopId: canonical.id,
    };

    const nextStops = [...currentStops];
    nextStops.splice(insertedStopIndex, 0, insertedStop);

    if (!customRouteId) {
      const { data: existingCustom, error: existingCustomErr } = await admin
        .from("custom_routes")
        .select("id")
        .eq("jam_id", jamRow.id)
        .maybeSingle();
      if (existingCustomErr) throw new Error(existingCustomErr.message);
      customRouteId = existingCustom?.id ?? null;
    }

    if (customRouteId) {
      const { error: updateErr } = await admin
        .from("custom_routes")
        .update({
          city,
          transport_mode: "walk",
          length_minutes: lengthMinutes,
          title: routeTitle,
          narrator_default: body.persona,
          narrator_guidance: narratorGuidance,
          narrator_voice: body.persona === "custom" ? narratorVoice : null,
          status: "ready",
        })
        .eq("id", customRouteId);
      if (updateErr) throw new Error(updateErr.message);
    } else {
      const { data: createdRoute, error: createRouteErr } = await admin
        .from("custom_routes")
        .insert({
          jam_id: jamRow.id,
          city,
          transport_mode: "walk",
          length_minutes: lengthMinutes,
          title: routeTitle,
          narrator_default: body.persona,
          narrator_guidance: narratorGuidance,
          narrator_voice: body.persona === "custom" ? narratorVoice : null,
          status: "ready",
        })
        .select("id")
        .single();
      if (createRouteErr || !createdRoute?.id) throw new Error(createRouteErr?.message || "Failed to create custom route.");
      customRouteId = createdRoute.id;
    }

    if (!customRouteId) throw new Error("Failed to resolve custom route id.");
    const resolvedCustomRouteId = customRouteId;

    const { error: deleteStopsErr } = await admin
      .from("custom_route_stops")
      .delete()
      .eq("route_id", resolvedCustomRouteId);
    if (deleteStopsErr) throw new Error(deleteStopsErr.message);

    const { error: deleteMappingsErr } = await admin
      .from("route_stop_mappings")
      .delete()
      .eq("route_kind", "custom")
      .eq("route_id", resolvedCustomRouteId);
    if (deleteMappingsErr) throw new Error(deleteMappingsErr.message);

    const stopInserts = nextStops.map((stop, position) => ({
      route_id: resolvedCustomRouteId,
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
    const { error: insertStopsErr } = await admin.from("custom_route_stops").insert(stopInserts);
    if (insertStopsErr) throw new Error(insertStopsErr.message);

    for (let i = 0; i < nextStops.length; i += 1) {
      const stop = nextStops[i];
      let canonicalStopId = stop.canonicalStopId;
      if (!canonicalStopId) {
        const ensured = await ensureCanonicalStopForCustom(admin, city, {
          id: stop.stopId,
          title: stop.title,
          lat: stop.lat,
          lng: stop.lng,
          image: stop.imageUrl,
        });
        canonicalStopId = ensured.id;
      }
      await upsertRouteStopMapping(admin, "custom", resolvedCustomRouteId, stop.stopId, canonicalStopId, i);
    }

    const { error: jamUpdateErr } = await admin
      .from("jams")
      .update({
        route_id: `custom:${resolvedCustomRouteId}`,
        current_stop: insertedStopIndex,
        persona: body.persona,
        completed_at: null,
      })
      .eq("id", jamRow.id);
    if (jamUpdateErr) throw new Error(jamUpdateErr.message);

    const totalMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        event: "nearby_story.generate",
        jamId: jamRow.id,
        source: resolved.candidate.source,
        distanceMeters: resolved.candidate.distanceMeters,
        insertedStopIndex,
        resolverMs,
        totalMs,
        reusedScript,
        reusedAudio,
      })
    );

    return NextResponse.json({
      routeRef: `custom:${resolvedCustomRouteId}`,
      insertedStopId: insertedStop.stopId,
      insertedStopIndex,
      autoplay: true,
      source: resolved.candidate.source,
      distanceMeters: resolved.candidate.distanceMeters,
    });
  } catch (e) {
    console.error("nearby story generation failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate nearby story." },
      { status: 500 }
    );
  }
}
