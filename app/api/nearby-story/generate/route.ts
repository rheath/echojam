import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Persona } from "@/app/content/salemRoutes";
import { resolveNearbyPlace } from "@/lib/nearbyPlaceResolver";
import { appendAcceptedNearbyStop } from "@/lib/server/walkDiscovery";

type Body = {
  jamId: string;
  persona: Persona;
  lat: number;
  lng: number;
  currentStopIndex: number | null;
  city?: "salem" | "boston" | "concord" | "nyc";
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

function isFiniteCoord(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 180;
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
    const resolverStartedAt = Date.now();
    const resolved = await resolveNearbyPlace({
      admin,
      city: body.city ?? "nearby",
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

    const accepted = await appendAcceptedNearbyStop({
      admin,
      jamId: body.jamId,
      persona: body.persona,
      candidate: resolved.candidate,
      city: body.city ?? null,
      insertAfterStopIndex: body.currentStopIndex,
    });

    const totalMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        event: "nearby_story.generate",
        jamId: body.jamId,
        source: resolved.candidate.source,
        distanceMeters: resolved.candidate.distanceMeters,
        insertedStopIndex: accepted.insertedStopIndex,
        resolverMs,
        totalMs,
        reusedScript: accepted.reusedScript,
        reusedAudio: accepted.reusedAudio,
      })
    );

    return NextResponse.json({
      routeRef: accepted.routeRef,
      insertedStopId: accepted.insertedStopId,
      insertedStopIndex: accepted.insertedStopIndex,
      autoplay: true,
      source: accepted.source,
      distanceMeters: accepted.distanceMeters,
    });
  } catch (e) {
    console.error("nearby story generation failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate nearby story." },
      { status: 500 }
    );
  }
}
