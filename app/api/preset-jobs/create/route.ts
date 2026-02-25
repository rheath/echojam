import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById } from "@/app/content/salemRoutes";
import {
  generateScriptWithOpenAI,
  getSwitchConfig,
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

async function runPresetGeneration(jobId: string, jamId: string, routeId: string, city: string, stops: StopInput[]) {
  const admin = getAdmin();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");

  const switchConfig = await getSwitchConfig();
  const forceScript = shouldRegenerateScript(switchConfig.mode);
  const forceAudio = shouldRegenerateAudio(switchConfig.mode);
  const personas: Persona[] = ["adult", "preteen"];

  const totalUnits = personas.length * stops.length * 2;
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

  await updateProgress("generating_script", "Generating scripts");
  for (const persona of personas) {
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      const { data: current } = await admin
        .from("preset_route_stop_assets")
        .select("script,audio_url,status,error")
        .eq("preset_route_id", routeId)
        .eq("stop_id", stop.id)
        .eq("persona", persona)
        .maybeSingle();

      let script = !forceScript ? toNullableTrimmed(current?.script) : null;
      if (!script) {
        try {
          const generated = await generateScriptWithOpenAI(apiKey, city, "walk", 30, persona, stop, i, stops.length);
          script = toNullableTrimmed(generated);
        } catch (e) {
          warningCount += 1;
          lastWarning = `Script generation failed for ${persona} at "${stop.title}": ${e instanceof Error ? e.message : "Unknown error"}`;
        }
      }

      await admin.from("preset_route_stop_assets").upsert(
        {
          preset_route_id: routeId,
          stop_id: stop.id,
          persona,
          script,
          audio_url: toNullableTrimmed(current?.audio_url),
          status: script ? "ready" : "failed",
          error: script ? null : lastWarning || "Script generation failed",
        },
        { onConflict: "preset_route_id,stop_id,persona" }
      );

      doneUnits += 1;
      await updateProgress("generating_script", `Generating scripts (${doneUnits}/${totalUnits})`);
    }
  }

  await updateProgress("generating_audio", "Generating audio");
  for (const persona of personas) {
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      const { data: current } = await admin
        .from("preset_route_stop_assets")
        .select("script,audio_url")
        .eq("preset_route_id", routeId)
        .eq("stop_id", stop.id)
        .eq("persona", persona)
        .maybeSingle();

      const replayUrl = toNullableTrimmed(switchConfig.replay_audio[stop.id]?.[persona]);
      let audioUrl = !forceAudio ? toNullableTrimmed(current?.audio_url) : null;
      if (replayUrl) audioUrl = replayUrl;

      const script = toNullableTrimmed(current?.script);
      if (!audioUrl && script) {
        try {
          const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, persona, script);
          audioUrl = toNullableTrimmed(await uploadNarrationAudio(audioBytes, `preset-${routeId}`, persona, stop.id));
        } catch (e) {
          warningCount += 1;
          lastWarning = `Audio generation failed for ${persona} at "${stop.title}": ${e instanceof Error ? e.message : "Unknown error"}`;
        }
      } else if (!audioUrl && !script) {
        warningCount += 1;
        lastWarning = `Audio skipped for ${persona} at "${stop.title}" because script is missing`;
      }

      if (audioUrl) audioReadyCount += 1;

      await admin.from("preset_route_stop_assets").upsert(
        {
          preset_route_id: routeId,
          stop_id: stop.id,
          persona,
          script,
          audio_url: audioUrl,
          status: audioUrl ? "ready" : "failed",
          error: audioUrl ? null : lastWarning || "Audio generation failed",
        },
        { onConflict: "preset_route_id,stop_id,persona" }
      );

      doneUnits += 1;
      await updateProgress("generating_audio", `Generating audio (${doneUnits}/${totalUnits})`);
    }
  }

  if (audioReadyCount === 0) {
    throw new Error(lastWarning || "Audio generation failed for all preset stops/personas.");
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

    void runPresetGeneration(job.id, resolvedJamId, route.id, body.city ?? "salem", stops).catch(async (e) => {
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
