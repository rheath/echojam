import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Persona } from "@/app/content/salemRoutes";
import {
  appendAcceptedNearbyStop,
  createDiscoveryJam,
} from "@/lib/server/walkDiscovery";
import { resolveWalkDiscoverySuggestion } from "@/lib/server/walkDiscoverySuggestions";

type Body = {
  jamId?: string | null;
  lat: number;
  lng: number;
  persona?: Persona | null;
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function isFiniteCoord(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 180;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!isFiniteCoord(body.lat) || !isFiniteCoord(body.lng) || Math.abs(body.lat) > 90) {
      return NextResponse.json({ error: "Valid geolocation is required." }, { status: 400 });
    }

    const admin = getAdmin();
    const persona = (body.persona || "adult") as Persona;
    const jamId = body.jamId || (await createDiscoveryJam(admin, persona));
    const candidate = await resolveWalkDiscoverySuggestion({
      admin,
      lat: body.lat,
      lng: body.lng,
    });

    if (!candidate) {
      return NextResponse.json(
        { error: "No nearby place found to start On the Move." },
        { status: 404 }
      );
    }

    const accepted = await appendAcceptedNearbyStop({
      admin,
      jamId,
      persona,
      candidate,
      routeTitle: "On the Move",
      experienceKind: "walk_discovery",
    });

    return NextResponse.json({
      jamId,
      routeId: accepted.routeId,
      routeRef: accepted.routeRef,
      insertedStopId: accepted.insertedStopId,
      insertedStopIndex: accepted.insertedStopIndex,
      source: accepted.source,
      distanceMeters: accepted.distanceMeters,
      startupSuggestionKey: candidate.candidateKey,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to start On the Move.",
      },
      { status: 500 }
    );
  }
}
