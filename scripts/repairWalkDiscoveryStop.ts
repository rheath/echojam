import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Persona } from "@/app/content/salemRoutes";
import {
  ensureCanonicalStopForNearby,
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
import { resolvePlaceDetails } from "@/lib/placesImages";

type RouteRow = {
  id: string;
  jam_id: string | null;
  title: string;
  length_minutes: number | null;
  city: string | null;
  narrator_default: Persona | null;
  narrator_guidance: string | null;
  narrator_voice: string | null;
  experience_kind: "mix" | "follow_along" | "walk_discovery" | null;
};

type StopRow = {
  stop_id: string;
  title: string;
  lat: number;
  lng: number;
  image_url: string | null;
  position: number;
  script_adult: string | null;
  script_preteen: string | null;
  script_ghost: string | null;
  script_custom: string | null;
  audio_url_adult: string | null;
  audio_url_preteen: string | null;
  audio_url_ghost: string | null;
  audio_url_custom: string | null;
};

type MappingRow = {
  canonical_stop_id: string;
  position: number;
};

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, ".env.local");

function parseArgs() {
  const args = process.argv.slice(2);
  let routeId = "";
  let stopId = "";

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    const next = args[idx + 1];
    if (arg === "--routeId" && next) {
      routeId = next.trim();
      idx += 1;
      continue;
    }
    if (arg === "--stopId" && next) {
      stopId = next.trim();
      idx += 1;
    }
  }

  if (!routeId || !stopId) {
    throw new Error("Usage: --routeId <customRouteId> --stopId <stopId>");
  }

  return { routeId, stopId };
}

async function loadEnvFromDotLocal() {
  try {
    const raw = await fs.readFile(ENV_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (!key || process.env[key]) continue;
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Optional local env file.
  }
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizePersona(value: string | null | undefined): Persona {
  if (value === "adult" || value === "preteen" || value === "ghost" || value === "custom") {
    return value;
  }
  return "adult";
}

function buildNarrationPatch(persona: Persona, script: string, audioUrl: string) {
  if (persona === "adult") {
    return {
      script_adult: script,
      audio_url_adult: audioUrl,
    };
  }
  if (persona === "preteen") {
    return {
      script_preteen: script,
      audio_url_preteen: audioUrl,
    };
  }
  if (persona === "ghost") {
    return {
      script_ghost: script,
      audio_url_ghost: audioUrl,
    };
  }
  return {
    script_custom: script,
    audio_url_custom: audioUrl,
  };
}

async function main() {
  await loadEnvFromDotLocal();
  const { routeId, stopId } = parseArgs();
  const admin = getAdmin();

  const { data: route, error: routeErr } = await admin
    .from("custom_routes")
    .select(
      "id,jam_id,title,length_minutes,city,narrator_default,narrator_guidance,narrator_voice,experience_kind"
    )
    .eq("id", routeId)
    .single();
  if (routeErr || !route) {
    throw new Error(routeErr?.message || "Custom route not found.");
  }

  const routeMeta = route as RouteRow;
  if (routeMeta.experience_kind !== "walk_discovery") {
    throw new Error("This repair script only supports walk_discovery routes.");
  }

  const { data: stops, error: stopsErr } = await admin
    .from("custom_route_stops")
    .select(
      "stop_id,title,lat,lng,image_url,position,script_adult,script_preteen,script_ghost,script_custom,audio_url_adult,audio_url_preteen,audio_url_ghost,audio_url_custom"
    )
    .eq("route_id", routeId)
    .order("position", { ascending: true });
  if (stopsErr) {
    throw new Error(stopsErr.message);
  }

  const stopRows = (stops ?? []) as StopRow[];
  const targetStop = stopRows.find((stop) => stop.stop_id === stopId);
  if (!targetStop) {
    throw new Error(`Stop ${stopId} was not found on route ${routeId}.`);
  }

  const { data: mapping, error: mappingErr } = await admin
    .from("route_stop_mappings")
    .select("canonical_stop_id,position")
    .eq("route_kind", "custom")
    .eq("route_id", routeId)
    .eq("stop_id", stopId)
    .maybeSingle();
  if (mappingErr) {
    throw new Error(mappingErr.message);
  }

  const city = toNullableTrimmed(routeMeta.city) || "salem";
  const resolved = await resolvePlaceDetails({
    title: targetStop.title,
    lat: targetStop.lat,
    lng: targetStop.lng,
    city,
  });
  if (!resolved) {
    throw new Error(`Could not resolve a Google place for "${targetStop.title}".`);
  }

  const canonical = await ensureCanonicalStopForNearby(admin, city, {
    id: stopId,
    title: resolved.title,
    lat: resolved.lat,
    lng: resolved.lng,
    image: resolved.imageUrl,
    googlePlaceId: resolved.googlePlaceId,
  });
  const currentMapping = (mapping ?? null) as MappingRow | null;
  const canonicalChanged = currentMapping?.canonical_stop_id !== canonical.id;

  const baseStopPatch = {
    title: resolved.title,
    lat: resolved.lat,
    lng: resolved.lng,
    image_url: resolved.imageUrl,
  };

  const { error: updateStopErr } = await admin
    .from("custom_route_stops")
    .update(baseStopPatch)
    .eq("route_id", routeId)
    .eq("stop_id", stopId);
  if (updateStopErr) {
    throw new Error(updateStopErr.message);
  }

  await upsertRouteStopMapping(
    admin,
    "custom",
    routeId,
    stopId,
    canonical.id,
    currentMapping?.position ?? targetStop.position
  );

  if (canonicalChanged) {
    const persona = normalizePersona(routeMeta.narrator_default);
    const narratorGuidance = toNullableTrimmed(routeMeta.narrator_guidance);
    let narratorVoice = toCustomNarratorVoice(routeMeta.narrator_voice);
    if (persona === "custom" && !narratorGuidance) {
      throw new Error("Custom narrator routes require narrator guidance for repair.");
    }
    if (persona === "custom" && !narratorVoice && narratorGuidance) {
      narratorVoice = selectCustomNarratorVoice(narratorGuidance);
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required to regenerate repaired stop narration.");
    }

    const selectedScript = toNullableTrimmed(
      await generateScriptWithOpenAI(
        apiKey,
        city,
        "walk",
        routeMeta.length_minutes || 30,
        persona,
        {
          id: stopId,
          title: resolved.title,
          lat: resolved.lat,
          lng: resolved.lng,
          image: resolved.imageUrl,
          googlePlaceId: resolved.googlePlaceId,
        },
        targetStop.position,
        Math.max(1, stopRows.length),
        narratorGuidance
      )
    );
    if (!selectedScript) {
      throw new Error("Generated repaired narration was empty.");
    }

    const audioBytes = await synthesizeSpeechWithOpenAI(
      apiKey,
      persona,
      selectedScript,
      narratorVoice
    );
    const uploadedAudioUrl = toNullableAudioUrl(
      await uploadNarrationAudio(
        audioBytes,
        routeMeta.jam_id ? `nearby-${routeMeta.jam_id}` : `nearby-repair-${routeId}`,
        persona,
        canonical.id
      )
    );
    if (!uploadedAudioUrl) {
      throw new Error("Generated repaired audio URL was empty.");
    }

    if (persona !== "custom") {
      const { error: assetErr } = await admin.from("canonical_stop_assets").upsert(
        {
          canonical_stop_id: canonical.id,
          persona,
          script: selectedScript,
          audio_url: uploadedAudioUrl,
          status: "ready",
          error: null,
        },
        { onConflict: "canonical_stop_id,persona" }
      );
      if (assetErr) {
        throw new Error(assetErr.message);
      }
    }

    const { error: narrationPatchErr } = await admin
      .from("custom_route_stops")
      .update(buildNarrationPatch(persona, selectedScript, uploadedAudioUrl))
      .eq("route_id", routeId)
      .eq("stop_id", stopId);
    if (narrationPatchErr) {
      throw new Error(narrationPatchErr.message);
    }
  }

  console.log(
    JSON.stringify(
      {
        routeId,
        stopId,
        previousCanonicalStopId: currentMapping?.canonical_stop_id ?? null,
        repairedCanonicalStopId: canonical.id,
        canonicalChanged,
        title: resolved.title,
        lat: resolved.lat,
        lng: resolved.lng,
        googlePlaceId: resolved.googlePlaceId,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Failed to repair walk discovery stop.");
  process.exitCode = 1;
});
