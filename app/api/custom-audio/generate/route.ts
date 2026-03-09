import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Persona } from "@/app/content/salemRoutes";
import { ensureCanonicalStopForCustom, upsertRouteStopMapping } from "@/lib/canonicalStops";
import {
  selectCustomNarratorVoice,
  getSwitchConfig,
  shouldRegenerateAudio,
  synthesizeSpeechWithOpenAI,
  toCustomNarratorVoice,
  toNullableAudioUrl,
  toNullableTrimmed,
  uploadNarrationAudio,
} from "@/lib/mixGeneration";

type Body = {
  routeId: string;
  stopId: string;
  persona: Persona;
  city?: "salem" | "boston" | "concord" | "nyc";
};

const AUDIO_PATCH_BY_PERSONA = {
  adult: (audioUrl: string) => ({ audio_url_adult: audioUrl }),
  preteen: (audioUrl: string) => ({ audio_url_preteen: audioUrl }),
  ghost: (audioUrl: string) => ({ audio_url_ghost: audioUrl }),
  custom: (audioUrl: string) => ({ audio_url_custom: audioUrl }),
} as const;

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const admin = getAdmin();

    const { data: route, error: routeErr } = await admin
      .from("custom_routes")
      .select("id,city,narrator_guidance,narrator_voice")
      .eq("id", body.routeId)
      .single();
    if (routeErr || !route) return NextResponse.json({ error: routeErr?.message || "Unknown custom route" }, { status: 404 });

    const { data: stop, error: stopErr } = await admin
      .from("custom_route_stops")
      .select("route_id,stop_id,position,title,lat,lng,image_url")
      .eq("route_id", body.routeId)
      .eq("stop_id", body.stopId)
      .single();
    if (stopErr || !stop) return NextResponse.json({ error: stopErr?.message || "Unknown stop for route" }, { status: 404 });

    const city = body.city ?? route.city;
    if (body.persona === "custom") {
      const narratorGuidance = toNullableTrimmed(route.narrator_guidance);
      if (!narratorGuidance) {
        return NextResponse.json({ error: "Narrator guidance is missing for this route." }, { status: 400 });
      }
      let narratorVoice = toCustomNarratorVoice(route.narrator_voice);
      if (!narratorVoice) {
        narratorVoice = selectCustomNarratorVoice(narratorGuidance);
        await admin.from("custom_routes").update({ narrator_voice: narratorVoice }).eq("id", body.routeId);
      }

      const switchConfig = await getSwitchConfig();
      const forceAudio = shouldRegenerateAudio(switchConfig.mode);
      const replayUrl = toNullableAudioUrl(switchConfig.replay_audio[stop.stop_id]?.[body.persona]);

      const { data: currentStopRow } = await admin
        .from("custom_route_stops")
        .select("script_custom,audio_url_custom")
        .eq("route_id", body.routeId)
        .eq("stop_id", body.stopId)
        .maybeSingle();

      const script = toNullableTrimmed(currentStopRow?.script_custom);
      if (!script) {
        return NextResponse.json({ error: "Script not generated yet for this stop/persona." }, { status: 400 });
      }

      let audioUrl = !forceAudio ? toNullableAudioUrl(currentStopRow?.audio_url_custom) : null;
      if (replayUrl) audioUrl = replayUrl;
      if (audioUrl) return NextResponse.json({ audioUrl, reused: true });

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is required." }, { status: 500 });

      audioUrl = toNullableAudioUrl(
        await uploadNarrationAudio(
          await synthesizeSpeechWithOpenAI(apiKey, body.persona, script, narratorVoice),
          `custom-${body.routeId}`,
          body.persona,
          stop.stop_id
        )
      );
      if (!audioUrl) return NextResponse.json({ error: "Generated audio URL was empty" }, { status: 500 });

      const audioPatch = AUDIO_PATCH_BY_PERSONA[body.persona](audioUrl);
      await admin.from("custom_route_stops").update(audioPatch).eq("route_id", body.routeId).eq("stop_id", body.stopId);

      return NextResponse.json({ audioUrl, reused: false });
    }

    const canonical = await ensureCanonicalStopForCustom(admin, city, {
      id: stop.stop_id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: stop.image_url,
    });
    await upsertRouteStopMapping(admin, "custom", body.routeId, stop.stop_id, canonical.id, stop.position);

    const switchConfig = await getSwitchConfig();
    const forceAudio = shouldRegenerateAudio(switchConfig.mode);
    const replayUrl = toNullableAudioUrl(switchConfig.replay_audio[stop.stop_id]?.[body.persona]);

    const { data: current } = await admin
      .from("canonical_stop_assets")
      .select("script,audio_url,status,error")
      .eq("canonical_stop_id", canonical.id)
      .eq("persona", body.persona)
      .maybeSingle();

    const script = toNullableTrimmed(current?.script);
    if (!script) {
      return NextResponse.json({ error: "Script not generated yet for this stop/persona." }, { status: 400 });
    }

    let audioUrl = !forceAudio ? toNullableAudioUrl(current?.audio_url) : null;
    if (replayUrl) audioUrl = replayUrl;
    if (audioUrl) return NextResponse.json({ audioUrl, reused: true });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is required." }, { status: 500 });

    const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, body.persona, script);
    audioUrl = toNullableAudioUrl(await uploadNarrationAudio(audioBytes, `custom-${body.routeId}`, body.persona, stop.stop_id));
    if (!audioUrl) return NextResponse.json({ error: "Generated audio URL was empty" }, { status: 500 });

    await admin.from("canonical_stop_assets").upsert(
      {
        canonical_stop_id: canonical.id,
        persona: body.persona,
        script,
        audio_url: audioUrl,
        status: "ready",
        error: null,
      },
      { onConflict: "canonical_stop_id,persona" }
    );

    const audioPatch = AUDIO_PATCH_BY_PERSONA[body.persona](audioUrl);
    await admin.from("custom_route_stops").update(audioPatch).eq("route_id", body.routeId).eq("stop_id", body.stopId);

    return NextResponse.json({ audioUrl, reused: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate custom audio" },
      { status: 500 }
    );
  }
}
