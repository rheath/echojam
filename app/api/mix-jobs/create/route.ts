import { after, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ensureCanonicalStopForCustom, upsertRouteStopMapping } from "@/lib/canonicalStops";
import {
  generateScriptWithOpenAI,
  getSwitchConfig,
  isUsableGeneratedAudioUrl,
  shouldRegenerateAudio,
  shouldRegenerateScript,
  synthesizeSpeechWithOpenAI,
  toNullableAudioUrl,
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

const CREATE_JOB_REQUEST_TIMEOUT_MS = 12000;

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function runGeneration(
  jobId: string,
  routeId: string,
  city: string,
  transportMode: TransportMode,
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
    await admin.from("mix_generation_jobs").update({ status, message, progress }).eq("id", jobId);
  };

  type RowState = {
    stop: StopInput;
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

    const { data: assetRow } = await admin
      .from("canonical_stop_assets")
      .select("script,audio_url")
      .eq("canonical_stop_id", canonical.id)
      .eq("persona", persona)
      .maybeSingle();

    let script = !forceScript ? toNullableTrimmed(assetRow?.script) : null;
    if (!script) {
      try {
        script = toNullableTrimmed(
          await generateScriptWithOpenAI(apiKey, city, transportMode, lengthMinutes, persona, stop, i, stops.length)
        );
      } catch (e) {
        warningCount += 1;
        lastWarning = `Script generation failed for ${persona} at stop "${stop.title}": ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    }

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

    const scriptPatch =
      persona === "adult" ? { script_adult: script } : { script_preteen: script };
    await admin.from("custom_route_stops").update(scriptPatch).eq("route_id", routeId).eq("stop_id", stop.id);

    states.push({ stop, canonicalStopId: canonical.id, script, audioUrl: null });
    doneUnits += 1;
    await updateProgress("generating_script", `Generating scripts (${doneUnits}/${totalUnits})`);
  }

  await updateProgress("generating_audio", "Generating audio");
  for (const state of states) {
    const replayUrl = toNullableAudioUrl(switchConfig.replay_audio[state.stop.id]?.[persona]);
    const { data: assetRow } = await admin
      .from("canonical_stop_assets")
      .select("script,audio_url")
      .eq("canonical_stop_id", state.canonicalStopId)
      .eq("persona", persona)
      .maybeSingle();

    const currentScript = toNullableTrimmed(assetRow?.script) || state.script;
    let audioUrl = !forceAudio ? toNullableAudioUrl(assetRow?.audio_url) : null;
    if (replayUrl) audioUrl = replayUrl;

    if (!audioUrl && currentScript) {
      try {
        const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, persona, currentScript);
        audioUrl = toNullableAudioUrl(
          await uploadNarrationAudio(audioBytes, `custom-${routeId}`, persona, state.stop.id)
        );
      } catch (e) {
        warningCount += 1;
        lastWarning = `Audio generation failed for ${persona} at stop "${state.stop.title}": ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    } else if (!audioUrl && !currentScript) {
      warningCount += 1;
      lastWarning = `Audio generation skipped for ${persona} at stop "${state.stop.title}" because script is missing`;
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

    const audioPatch =
      persona === "adult" ? { audio_url_adult: audioUrl } : { audio_url_preteen: audioUrl };
    await admin.from("custom_route_stops").update(audioPatch).eq("route_id", routeId).eq("stop_id", state.stop.id);

    doneUnits += 1;
    await updateProgress("generating_audio", `Generating audio (${doneUnits}/${totalUnits})`);
  }

  if (audioReadyCount === 0) {
    throw new Error(lastWarning || `Audio generation failed for persona ${persona}.`);
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
    const timeoutResponse = new Promise<NextResponse>((resolve) => {
      setTimeout(() => {
        console.warn("mix-jobs/create timed out before responding");
        resolve(NextResponse.json({ error: "Timed out creating mix job" }, { status: 504 }));
      }, CREATE_JOB_REQUEST_TIMEOUT_MS);
    });

    const createResponse = await Promise.race([
      (async () => {
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

        const { data: activeJob } = await admin
          .from("mix_generation_jobs")
          .select("id,status")
          .eq("jam_id", jamId)
          .in("status", ["queued", "generating_script", "generating_audio"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (activeJob?.id) {
          return NextResponse.json(
            {
              error: "A generation job is already in progress for this jam.",
              jobId: activeJob.id,
              status: activeJob.status,
            },
            { status: 429 }
          );
        }

        const routeTitle = `${body.city[0].toUpperCase()}${body.city.slice(1)} Custom Mix`;
        const { data: existingRoute } = await admin
          .from("custom_routes")
          .select("id")
          .eq("jam_id", jamId)
          .maybeSingle();

        let routeId = existingRoute?.id as string | undefined;
        if (routeId) {
          const { error: updateRouteErr } = await admin
            .from("custom_routes")
            .update({
              city: body.city,
              transport_mode: body.transportMode,
              length_minutes: body.lengthMinutes,
              title: routeTitle,
              narrator_default: body.persona,
              status: "generating",
            })
            .eq("id", routeId);
          if (updateRouteErr) throw new Error(updateRouteErr.message || "Failed to update custom route");
        } else {
          const { data: route, error: routeErr } = await admin
            .from("custom_routes")
            .insert({
              jam_id: jamId,
              city: body.city,
              transport_mode: body.transportMode,
              length_minutes: body.lengthMinutes,
              title: routeTitle,
              narrator_default: body.persona,
              status: "generating",
            })
            .select("id")
            .single();
          if (routeErr || !route?.id) throw new Error(routeErr?.message || "Failed to create custom route");
          routeId = route.id as string;
        }
        if (!routeId) throw new Error("Failed to resolve custom route id");

        const { error: deleteStopsErr } = await admin.from("custom_route_stops").delete().eq("route_id", routeId);
        if (deleteStopsErr) throw new Error(deleteStopsErr.message || "Failed to clear previous custom route stops");
        const { error: deleteMappingsErr } = await admin
          .from("route_stop_mappings")
          .delete()
          .eq("route_kind", "custom")
          .eq("route_id", routeId);
        if (deleteMappingsErr) throw new Error(deleteMappingsErr.message || "Failed to clear previous custom route mappings");
        await admin
          .from("jams")
          .update({ route_id: `custom:${routeId}`, persona: body.persona, current_stop: 0, completed_at: null, preset_id: null })
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

        after(async () => {
          try {
            await runGeneration(
              job.id,
              routeId,
              body.city,
              body.transportMode,
              body.lengthMinutes,
              body.persona,
              body.stops
            );
          } catch (e) {
            console.error("mix job generation failed", { jobId: job.id, routeId, error: e });
            await admin.from("custom_routes").update({ status: "failed" }).eq("id", routeId);
            await admin
              .from("mix_generation_jobs")
              .update({ status: "failed", message: "Generation failed", error: e instanceof Error ? e.message : "Unknown error" })
              .eq("id", job.id);
          }
        });

        return NextResponse.json({ jamId, routeId, routeRef: `custom:${routeId}`, jobId: job.id });
      })(),
      timeoutResponse,
    ]);

    return createResponse;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create mix job" }, { status: 500 });
  }
}
