import type { SupabaseClient } from "@supabase/supabase-js";
import { toNullableAudioUrl, toNullableTrimmed, type Persona } from "@/lib/mixGeneration";

export type PresetAssetPersona = Exclude<Persona, "custom">;

export type PresetRouteStopAssetRow = {
  preset_route_id: string;
  stop_id: string;
  persona: PresetAssetPersona;
  script: string | null;
  audio_url: string | null;
  status: string | null;
  error: string | null;
};

export function mergePresetNarratorGuidance(
  routeNarratorGuidance?: string | null,
  stopNarratorGuidance?: string | null
) {
  const routeGuidance = toNullableTrimmed(routeNarratorGuidance);
  const stopGuidance = toNullableTrimmed(stopNarratorGuidance);
  if (!routeGuidance && !stopGuidance) return null;
  if (routeGuidance && stopGuidance) {
    return [
      "Use the overall route guidance as the baseline voice, but prioritize the stop-specific guidance for this stop.",
      "If the stop-specific guidance includes named examples, characters, places, or fictional worlds, mention at least one of them explicitly in the narration when it fits naturally.",
      `Overall route guidance: ${routeGuidance}`,
      `Stop-specific guidance (highest priority): ${stopGuidance}`,
    ].join("\n");
  }

  return [
    routeGuidance ? `Overall route guidance: ${routeGuidance}` : null,
    stopGuidance
      ? [
          "If the stop-specific guidance includes named examples, characters, places, or fictional worlds, mention at least one of them explicitly in the narration when it fits naturally.",
          `Stop-specific guidance (highest priority): ${stopGuidance}`,
        ].join("\n")
      : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export async function getPresetRouteStopAsset(
  admin: SupabaseClient,
  routeId: string,
  stopId: string,
  persona: PresetAssetPersona
) {
  const { data, error } = await admin
    .from("preset_route_stop_assets")
    .select("preset_route_id,stop_id,persona,script,audio_url,status,error")
    .eq("preset_route_id", routeId)
    .eq("stop_id", stopId)
    .eq("persona", persona)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as PresetRouteStopAssetRow | null;
}

export async function listPresetRouteStopAssets(
  admin: SupabaseClient,
  routeId: string,
  stopIds: string[]
) {
  if (stopIds.length === 0) return [] as PresetRouteStopAssetRow[];

  const { data, error } = await admin
    .from("preset_route_stop_assets")
    .select("preset_route_id,stop_id,persona,script,audio_url,status,error")
    .eq("preset_route_id", routeId)
    .in("stop_id", stopIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as PresetRouteStopAssetRow[];
}

export async function upsertPresetRouteStopAsset(
  admin: SupabaseClient,
  row: PresetRouteStopAssetRow
) {
  const { error } = await admin.from("preset_route_stop_assets").upsert(row, {
    onConflict: "preset_route_id,stop_id,persona",
  });
  if (error) throw new Error(error.message);
}

export function mapPresetAssetsByStop(rows: PresetRouteStopAssetRow[]) {
  const byStop = new Map<
    string,
    {
      script_adult: string | null;
      script_preteen: string | null;
      script_ghost: string | null;
      audio_url_adult: string | null;
      audio_url_preteen: string | null;
      audio_url_ghost: string | null;
    }
  >();

  for (const row of rows) {
    const entry = byStop.get(row.stop_id) ?? {
      script_adult: null,
      script_preteen: null,
      script_ghost: null,
      audio_url_adult: null,
      audio_url_preteen: null,
      audio_url_ghost: null,
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
    byStop.set(row.stop_id, entry);
  }

  return byStop;
}
