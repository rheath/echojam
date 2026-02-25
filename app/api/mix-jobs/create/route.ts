import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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
import { validateMixSelection, type TransportMode } from "@/lib/mixConstraints";

type CreateBody = {
  jamId?: string | null;
  city: "salem" | "boston" | "concord";
  transportMode: TransportMode;
  lengthMinutes: number;
  persona: Persona;
  stops: StopInput[];
};

type StopAssetCache = Partial<
  Record<
    string,
    {
      script_adult?: string | null;
      script_preteen?: string | null;
      audio_url_adult?: string | null;
      audio_url_preteen?: string | null;
    }
  >
>;

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

function isGeneratedAudioUrl(url: string | null | undefined) {
  return isUsableGeneratedAudioUrl(url);
}

async function loadReusableAssets(
  admin: ReturnType<typeof getAdmin>,
  stopIds: string[]
): Promise<StopAssetCache> {
  if (!stopIds.length) return {};
  const { data } = await admin
    .from("custom_route_stops")
    .select("stop_id,script_adult,script_preteen,audio_url_adult,audio_url_preteen,created_at")
    .in("stop_id", stopIds)
    .order("created_at", { ascending: false });

  const byStop: StopAssetCache = {};
  for (const row of data ?? []) {
    const stopId = row.stop_id as string;
    if (!byStop[stopId]) byStop[stopId] = {};
    const cached = byStop[stopId]!;

    const scriptAdult = toNullableTrimmed(row.script_adult);
    const scriptPreteen = toNullableTrimmed(row.script_preteen);
    const audioAdult = toNullableTrimmed(row.audio_url_adult);
    const audioPreteen = toNullableTrimmed(row.audio_url_preteen);

    if (!cached.script_adult && scriptAdult) cached.script_adult = scriptAdult;
    if (!cached.script_preteen && scriptPreteen) cached.script_preteen = scriptPreteen;
    if (!cached.audio_url_adult && isGeneratedAudioUrl(audioAdult)) cached.audio_url_adult = audioAdult;
    if (!cached.audio_url_preteen && isGeneratedAudioUrl(audioPreteen)) cached.audio_url_preteen = audioPreteen;
  }
  return byStop;
}

async function runGeneration(jobId: string, routeId: string, city: string, transportMode: TransportMode, lengthMinutes: number, stops: StopInput[]) {
  const admin = getAdmin();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  const switchConfig = await getSwitchConfig();
  const forceScript = shouldRegenerateScript(switchConfig.mode);
  const forceAudio = shouldRegenerateAudio(switchConfig.mode);
  const reusableAssets = await loadReusableAssets(
    admin,
    Array.from(new Set(stops.map((s) => s.id)))
  );

  const personas: Persona[] = ["adult", "preteen"];
  const totalUnits = personas.length * stops.length * 2;
  let doneUnits = 0;

  const updateProgress = async (status: string, message: string) => {
    const progress = Math.min(99, Math.floor((doneUnits / totalUnits) * 100));
    await admin.from("mix_generation_jobs").update({ status, message, progress }).eq("id", jobId);
  };

  await updateProgress("generating_script", "Generating scripts");
  let warningCount = 0;
  let lastWarning = "";
  for (const persona of personas) {
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      const { data: current } = await admin
        .from("custom_route_stops")
        .select("script_adult,script_preteen")
        .eq("route_id", routeId)
        .eq("stop_id", stop.id)
        .single();
      const existingScript = toNullableTrimmed(
        persona === "adult" ? current?.script_adult : current?.script_preteen
      );
      const reusableScript = toNullableTrimmed(
        persona === "adult" ? reusableAssets[stop.id]?.script_adult : reusableAssets[stop.id]?.script_preteen
      );

      let script = existingScript;
      if (!script && !forceScript && reusableScript) {
        script = reusableScript;
      }
      if (!script || forceScript) {
        try {
          const generated = await generateScriptWithOpenAI(apiKey, city, transportMode, lengthMinutes, persona, stop, i, stops.length);
          const normalizedGenerated = toNullableTrimmed(generated);
          if (normalizedGenerated) script = normalizedGenerated;
        } catch (e) {
          warningCount += 1;
          lastWarning = `Script generation failed for ${persona} at stop "${stop.title}": ${e instanceof Error ? e.message : "Unknown error"}`;
        }
      }
      script = toNullableTrimmed(script);
      const patch = persona === "adult" ? { script_adult: script } : { script_preteen: script };
      await admin.from("custom_route_stops").update(patch).eq("route_id", routeId).eq("stop_id", stop.id);
      doneUnits += 1;
      await updateProgress("generating_script", `Generating scripts (${doneUnits}/${totalUnits})`);
    }
  }

  await updateProgress("generating_audio", "Generating audio");
  let audioGeneratedCount = 0;
  for (const persona of personas) {
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      const { data: row } = await admin
        .from("custom_route_stops")
        .select("script_adult,script_preteen,audio_url_adult,audio_url_preteen")
        .eq("route_id", routeId)
        .eq("stop_id", stop.id)
        .single();
      const text = toNullableTrimmed(persona === "adult" ? row?.script_adult : row?.script_preteen);

      const replayUrl = toNullableTrimmed(switchConfig.replay_audio[stop.id]?.[persona]);
      const existingAudio = toNullableTrimmed(persona === "adult" ? row?.audio_url_adult : row?.audio_url_preteen);
      const reusableAudio = toNullableTrimmed(
        persona === "adult" ? reusableAssets[stop.id]?.audio_url_adult : reusableAssets[stop.id]?.audio_url_preteen
      );

      let audioUrl: string | null = null;
      if (replayUrl) {
        audioUrl = replayUrl;
      } else if (!forceAudio && isGeneratedAudioUrl(existingAudio)) {
        audioUrl = existingAudio;
      } else if (!forceAudio && reusableAudio) {
        audioUrl = reusableAudio;
      } else if (text) {
        try {
          const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, persona, text);
          const uploaded = await uploadNarrationAudio(audioBytes, routeId, persona, stop.id);
          const normalizedUploaded = toNullableTrimmed(uploaded);
          if (normalizedUploaded) {
            audioUrl = normalizedUploaded;
            audioGeneratedCount += 1;
          } else {
            warningCount += 1;
            lastWarning = `Audio upload returned empty URL for ${persona} at stop "${stop.title}"`;
          }
        } catch (e) {
          warningCount += 1;
          const detail = e instanceof Error ? e.message : "Unknown error";
          lastWarning = `Audio generation failed for ${persona} at stop "${stop.title}": ${detail}`;
        }
      } else {
        warningCount += 1;
        lastWarning = `Audio generation skipped for ${persona} at stop "${stop.title}" because script is missing`;
      }
      audioUrl = toNullableTrimmed(audioUrl);

      const patch = persona === "adult" ? { audio_url_adult: audioUrl } : { audio_url_preteen: audioUrl };
      await admin.from("custom_route_stops").update(patch).eq("route_id", routeId).eq("stop_id", stop.id);
      doneUnits += 1;
      await updateProgress("generating_audio", `Generating audio (${doneUnits}/${totalUnits})`);
    }
  }

  if (audioGeneratedCount === 0) {
    throw new Error(lastWarning || "Audio generation failed for all stops/personas.");
  }

  await admin.from("custom_routes").update({ status: "ready" }).eq("id", routeId);
  if (warningCount > 0) {
    const warning = `${warningCount} generation warnings. ${lastWarning || ""}`.trim();
    await admin
      .from("mix_generation_jobs")
      .update({ status: "ready_with_warnings", progress: 100, message: "Tour ready with warnings", error: warning })
      .eq("id", jobId);
    return;
  }
  await admin
    .from("mix_generation_jobs")
    .update({ status: "ready", progress: 100, message: "Tour ready", error: null })
    .eq("id", jobId);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateBody;
    const validation = validateMixSelection(body.lengthMinutes, body.transportMode, body.stops.length);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.message }, { status: 400 });
    }

    const admin = getAdmin();
    let jamId = body.jamId ?? null;
    if (!jamId) {
      const { data: jam, error: jamErr } = await admin
        .from("jams")
        .insert({
          host_name: "Rob",
          route_id: null,
          persona: body.persona,
          current_stop: 0,
          is_playing: false,
          position_ms: 0,
          preset_id: null,
        })
        .select("id")
        .single();
      if (jamErr || !jam?.id) throw new Error(jamErr?.message || "Failed to create jam");
      jamId = jam.id;
    }

    const { data: route, error: routeErr } = await admin
      .from("custom_routes")
      .insert({
        jam_id: jamId,
        city: body.city,
        transport_mode: body.transportMode,
        length_minutes: body.lengthMinutes,
        title: `${body.city[0].toUpperCase()}${body.city.slice(1)} Custom Mix`,
        narrator_default: body.persona,
        status: "generating",
      })
      .select("id")
      .single();
    if (routeErr || !route?.id) throw new Error(routeErr?.message || "Failed to create custom route");

    const routeId = route.id as string;
    const routeRef = `custom:${routeId}`;
    await admin
      .from("jams")
      .update({ route_id: routeRef, persona: body.persona, current_stop: 0, completed_at: null, preset_id: null })
      .eq("id", jamId);

    const inserts = body.stops.map((s, idx) => ({
      route_id: routeId,
      stop_id: s.id,
      position: idx,
      title: s.title,
      lat: s.lat,
      lng: s.lng,
      image_url: s.image,
    }));
    const { error: stopsErr } = await admin.from("custom_route_stops").insert(inserts);
    if (stopsErr) throw new Error(stopsErr.message);

    const { data: job, error: jobErr } = await admin
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
    if (jobErr || !job?.id) throw new Error(jobErr?.message || "Failed to create mix generation job");

    void runGeneration(job.id, routeId, body.city, body.transportMode, body.lengthMinutes, body.stops).catch(async (e) => {
      await admin.from("custom_routes").update({ status: "failed" }).eq("id", routeId);
      await admin
        .from("mix_generation_jobs")
        .update({ status: "failed", message: "Generation failed", error: e instanceof Error ? e.message : "Unknown error" })
        .eq("id", job.id);
    });

    return NextResponse.json({ jamId, routeId, routeRef, jobId: job.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create mix job" }, { status: 500 });
  }
}
