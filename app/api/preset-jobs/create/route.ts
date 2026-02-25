import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById } from "@/app/content/salemRoutes";
import { ensureCanonicalStopForPreset, upsertRouteStopMapping } from "@/lib/canonicalStops";
import {
  generateScriptWithOpenAI,
  getSwitchConfig,
  isUsableGeneratedAudioUrl,
  shouldRegenerateAudio,
  shouldRegenerateScript,
  synthesizeSpeechWithOpenAI,
  toNullableTrimmed,
  type Persona,
  type StopInput,
  uploadNarrationAudio,
} from "@/lib/mixGeneration";

type CreateBody = {
  jamId?: string | null;
  routeId: string;
  persona: Persona;
  city?: "salem" | "boston" | "concord";
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function runPresetGeneration(
  jobId: string,
  routeId: string,
  city: string,
  lengthMinutes: number,
  persona: Persona,
  stops: StopInput[]
) {
  const admin = getAdmin();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");

  const switchConfig = await getSwitchConfig();
  const forceScript = shouldRegenerateScript(switchConfig.mode);
  const forceAudio = shouldRegenerateAudio(switchConfig.mode);

  const totalUnits = Math.max(1, stops.length * 2);
  let doneUnits = 0;
  let warningCount = 0;
  let audioReadyCount = 0;
  let lastWarning = "";

  const updateProgress = async (
    status: "queued" | "generating_script" | "generating_audio" | "ready" | "ready_with_warnings" | "failed",
    message: string
  ) => {
    const progress = Math.min(99, Math.floor((doneUnits / totalUnits) * 100));
    await admin.from("preset_generation_jobs").update({ status, message, progress }).eq("id", jobId);
  };

  type RowState = {
    stop: StopInput;
    canonicalStopId: string;
    script: string | null;
  };
  const states: RowState[] = [];

  await updateProgress("generating_script", "Generating scripts");
  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i];
    const canonical = await ensureCanonicalStopForPreset(admin, city, stop);
    await upsertRouteStopMapping(admin, "preset", routeId, stop.id, canonical.id, i);

    const { data: current } = await admin
      .from("canonical_stop_assets")
      .select("script,audio_url")
      .eq("canonical_stop_id", canonical.id)
      .eq("persona", persona)
      .maybeSingle();

    let script = !forceScript ? toNullableTrimmed(current?.script) : null;
    if (!script) {
      try {
        script = toNullableTrimmed(
          await generateScriptWithOpenAI(apiKey, city, "walk", lengthMinutes, persona, stop, i, stops.length)
        );
      } catch (e) {
        warningCount += 1;
        lastWarning = `Script generation failed for ${persona} at "${stop.title}": ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    }

    await admin.from("canonical_stop_assets").upsert(
      {
        canonical_stop_id: canonical.id,
        persona,
        script,
        audio_url: toNullableTrimmed(current?.audio_url),
        status: script ? "ready" : "failed",
        error: script ? null : lastWarning || "Script generation failed",
      },
      { onConflict: "canonical_stop_id,persona" }
    );

    states.push({ stop, canonicalStopId: canonical.id, script });
    doneUnits += 1;
    await updateProgress("generating_script", `Generating scripts (${doneUnits}/${totalUnits})`);
  }

  await updateProgress("generating_audio", "Generating audio");
  for (const state of states) {
    const replayUrl = toNullableTrimmed(switchConfig.replay_audio[state.stop.id]?.[persona]);

    const { data: current } = await admin
      .from("canonical_stop_assets")
      .select("script,audio_url")
      .eq("canonical_stop_id", state.canonicalStopId)
      .eq("persona", persona)
      .maybeSingle();

    const currentScript = toNullableTrimmed(current?.script) || state.script;
    let audioUrl = !forceAudio ? toNullableTrimmed(current?.audio_url) : null;
    if (replayUrl) audioUrl = replayUrl;

    if (!audioUrl && currentScript) {
      try {
        const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, persona, currentScript);
        audioUrl = toNullableTrimmed(await uploadNarrationAudio(audioBytes, `preset-${routeId}`, persona, state.stop.id));
      } catch (e) {
        warningCount += 1;
        lastWarning = `Audio generation failed for ${persona} at "${state.stop.title}": ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    } else if (!audioUrl && !currentScript) {
      warningCount += 1;
      lastWarning = `Audio skipped for ${persona} at "${state.stop.title}" because script is missing`;
    }

    if (isUsableGeneratedAudioUrl(audioUrl)) audioReadyCount += 1;

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

    doneUnits += 1;
    await updateProgress("generating_audio", `Generating audio (${doneUnits}/${totalUnits})`);
  }

  if (audioReadyCount === 0) {
    throw new Error(lastWarning || `Audio generation failed for persona ${persona}.`);
  }

  if (warningCount > 0) {
    await admin
      .from("preset_generation_jobs")
      .update({
        status: "ready_with_warnings",
        progress: 100,
        message: "Preset ready with warnings",
        error: `${warningCount} generation warnings. ${lastWarning || ""}`.trim(),
      })
      .eq("id", jobId);
    return;
  }

  await admin
    .from("preset_generation_jobs")
    .update({ status: "ready", progress: 100, message: "Preset ready", error: null })
    .eq("id", jobId);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateBody;
    const route = getRouteById(body.routeId);
    if (!route) return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });

    const admin = getAdmin();
    let jamId = body.jamId ?? null;
    if (!jamId) {
      const { data: jam, error: jamErr } = await admin
        .from("jams")
        .insert({
          host_name: "Rob",
          route_id: route.id,
          persona: body.persona,
          current_stop: 0,
          is_playing: false,
          position_ms: 0,
        })
        .select("id")
        .single();
      if (jamErr || !jam?.id) throw new Error(jamErr?.message || "Failed to create jam");
      jamId = jam.id;
    } else {
      await admin
        .from("jams")
        .update({ route_id: route.id, persona: body.persona, current_stop: 0, completed_at: null })
        .eq("id", jamId);
    }

    const resolvedJamId = jamId;
    if (!resolvedJamId) throw new Error("Failed to resolve jam id");

    const { data: job, error: jobErr } = await admin
      .from("preset_generation_jobs")
      .insert({
        jam_id: resolvedJamId,
        preset_route_id: route.id,
        status: "queued",
        progress: 0,
        message: "Queued",
      })
      .select("id")
      .single();
    if (jobErr || !job?.id) throw new Error(jobErr?.message || "Failed to create preset generation job");

    const stops: StopInput[] = route.stops.map((s) => ({
      id: s.id,
      title: s.title,
      lat: s.lat,
      lng: s.lng,
      image: s.images[0] ?? "/images/salem/placeholder-01.png",
    }));

    void runPresetGeneration(
      job.id,
      route.id,
      body.city ?? "salem",
      parseInt(route.durationLabel, 10) || 30,
      body.persona,
      stops
    ).catch(async (e) => {
      await admin
        .from("preset_generation_jobs")
        .update({
          status: "failed",
          progress: 100,
          message: "Generation failed",
          error: e instanceof Error ? e.message : "Unknown error",
        })
        .eq("id", job.id);
    });

    return NextResponse.json({ jamId: resolvedJamId, routeId: route.id, jobId: job.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create preset job" }, { status: 500 });
  }
}
