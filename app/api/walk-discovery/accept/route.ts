import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Persona } from "@/app/content/salemRoutes";
import type { NearbyPlaceCandidate } from "@/lib/nearbyPlaceResolver";
import { appendAcceptedNearbyStop } from "@/lib/server/walkDiscovery";

type Body = {
  jamId?: string | null;
  routeId?: string | null;
  persona?: Persona | null;
  candidate?: NearbyPlaceCandidate | null;
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function resolveJamId(admin: ReturnType<typeof getAdmin>, body: Body) {
  if (body.jamId?.trim()) return body.jamId.trim();
  if (!body.routeId?.trim()) return null;

  const { data, error } = await admin
    .from("custom_routes")
    .select("jam_id")
    .eq("id", body.routeId.trim())
    .single();
  if (error || !data?.jam_id) {
    throw new Error(error?.message || "Unable to resolve journey for route.");
  }
  return data.jam_id as string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.candidate) {
      return NextResponse.json({ error: "A candidate is required." }, { status: 400 });
    }

    const admin = getAdmin();
    const jamId = await resolveJamId(admin, body);
    if (!jamId) {
      return NextResponse.json({ error: "jamId or routeId is required." }, { status: 400 });
    }

    const accepted = await appendAcceptedNearbyStop({
      admin,
      jamId,
      persona: (body.persona || "adult") as Persona,
      candidate: body.candidate,
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
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to accept nearby stop.",
      },
      { status: 500 }
    );
  }
}
