import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fallbackScript, generateScriptWithOpenAI, synthesizeSpeechWithOpenAI, uploadNarrationAudio, type Persona, type StopInput } from "@/lib/mixGeneration";
import { validateMixSelection, type TransportMode } from "@/lib/mixConstraints";

type CreateBody = {
  jamId?: string | null;
  city: "salem" | "boston" | "concord";
  transportMode: TransportMode;
  lengthMinutes: number;
  persona: Persona;
  stops: StopInput[];
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function runGeneration(jobId: string, routeId: string, city: string, transportMode: TransportMode, lengthMinutes: number, stops: StopInput[]) {
  const admin = getAdmin();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");

  const personas: Persona[] = ["adult", "preteen"];
  const totalUnits = personas.length * stops.length * 2;
  let doneUnits = 0;

  const updateProgress = async (status: string, message: string) => {
    const progress = Math.min(99, Math.floor((doneUnits / totalUnits) * 100));
    await admin.from("mix_generation_jobs").update({ status, message, progress }).eq("id", jobId);
  };

  await updateProgress("generating_script", "Generating scripts");
  for (const persona of personas) {
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      let script = fallbackScript(city, persona, stop, i);
      try {
        const generated = await generateScriptWithOpenAI(apiKey, city, transportMode, lengthMinutes, persona, stop, i, stops.length);
        if (generated) script = generated;
      } catch {
        // fallback kept
      }
      const patch = persona === "adult" ? { script_adult: script } : { script_preteen: script };
      await admin.from("custom_route_stops").update(patch).eq("route_id", routeId).eq("stop_id", stop.id);
      doneUnits += 1;
      await updateProgress("generating_script", `Generating scripts (${doneUnits}/${totalUnits})`);
    }
  }

  await updateProgress("generating_audio", "Generating audio");
  for (const persona of personas) {
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      const { data: row } = await admin
        .from("custom_route_stops")
        .select("script_adult,script_preteen")
        .eq("route_id", routeId)
        .eq("stop_id", stop.id)
        .single();
      const text = (persona === "adult" ? row?.script_adult : row?.script_preteen) || fallbackScript(city, persona, stop, i);

      let audioUrl = persona === "adult" ? "/audio/adult-01.mp3" : "/audio/kid-01.mp3";
      try {
        const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, persona, text);
        audioUrl = await uploadNarrationAudio(audioBytes, routeId, persona, stop.id);
      } catch {
        // placeholder fallback
      }

      const patch = persona === "adult" ? { audio_url_adult: audioUrl } : { audio_url_preteen: audioUrl };
      await admin.from("custom_route_stops").update(patch).eq("route_id", routeId).eq("stop_id", stop.id);
      doneUnits += 1;
      await updateProgress("generating_audio", `Generating audio (${doneUnits}/${totalUnits})`);
    }
  }

  await admin.from("custom_routes").update({ status: "ready" }).eq("id", routeId);
  await admin
    .from("mix_generation_jobs")
    .update({ status: "ready", progress: 100, message: "Tour ready" })
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
