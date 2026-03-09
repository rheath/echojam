import { after, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  buildFollowAlongStops,
  buildRouteCandidates,
  computeFollowAlongStoryCount,
  computeTriggerRadiusMeters,
  dedupeFollowAlongCandidates,
  deriveRouteCity,
  sampleRoutePoints,
  selectStoryCandidates,
  type FollowAlongLocation,
} from "@/lib/followAlong";
import {
  fetchDrivingRoutePreview,
  isValidFollowAlongLocation,
} from "@/lib/followAlongApi";
import { resolveNearbyPlaces } from "@/lib/nearbyPlaceResolver";
import {
  prepareCustomRouteJob,
  runCustomRouteGeneration,
} from "@/lib/customRouteGeneration";
import {
  selectCustomNarratorVoice,
  toNullableTrimmed,
  type Persona,
} from "@/lib/mixGeneration";

type Body = {
  jamId?: string | null;
  origin?: FollowAlongLocation;
  destination?: FollowAlongLocation;
  persona?: Persona;
  narratorGuidance?: string | null;
};

const FOLLOW_ALONG_INCLUDED_PRIMARY_TYPES = [
  "tourist_attraction",
  "museum",
  "art_gallery",
  "church",
  "library",
] as const;

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const persona = (body.persona || "adult") as Persona;
    const narratorGuidance = toNullableTrimmed(body.narratorGuidance);

    if (
      !isValidFollowAlongLocation(body.origin) ||
      !isValidFollowAlongLocation(body.destination)
    ) {
      return NextResponse.json(
        { error: "Valid origin and destination are required." },
        { status: 400 }
      );
    }
    if (persona === "custom" && !narratorGuidance) {
      return NextResponse.json(
        { error: "Narrator guidance is required." },
        { status: 400 }
      );
    }

    const preview = await fetchDrivingRoutePreview(body.origin, body.destination);
    const admin = getAdmin();
    const routeCity = deriveRouteCity(preview.destination);
    const storyCount = computeFollowAlongStoryCount(preview.durationSeconds);
    const intervalMeters = clamp(
      Math.round(preview.distanceMeters / Math.max(2, storyCount + 1)),
      5_000,
      18_000
    );
    const samples = sampleRoutePoints(
      preview.routeCoords,
      intervalMeters,
      Math.min(6_000, Math.max(1_500, preview.distanceMeters * 0.12)),
      Math.min(5_000, Math.max(1_000, preview.distanceMeters * 0.08))
    );

    if (samples.length === 0) {
      return NextResponse.json(
        { error: "Route is too short to generate Follow Along stories." },
        { status: 400 }
      );
    }

    const sampleResponses = await Promise.all(
      samples.map((sample) =>
        resolveNearbyPlaces({
          admin,
          city: routeCity,
          lat: sample.lat,
          lng: sample.lng,
          radiusMeters: 1_500,
          maxCandidates: 4,
          googleOnly: true,
          includedPrimaryTypes: [...FOLLOW_ALONG_INCLUDED_PRIMARY_TYPES],
          allowBroadGoogleFallback: false,
        })
      )
    );

    const candidates = buildRouteCandidates(
      preview.routeCoords,
      samples,
      sampleResponses.map((response) => response.candidates)
    ).filter(
      (candidate) =>
        candidate.distanceAlongRouteMeters > 1_500 &&
        candidate.distanceAlongRouteMeters < preview.distanceMeters - 800
    );
    const selectedStories = selectStoryCandidates(
      dedupeFollowAlongCandidates(candidates),
      storyCount,
      Math.max(4_000, Math.round(intervalMeters * 0.7))
    );

    if (selectedStories.length === 0) {
      return NextResponse.json(
        { error: "No interesting route stories were found for this drive." },
        { status: 404 }
      );
    }

    const averageSpeedMps =
      preview.durationSeconds > 0
        ? preview.distanceMeters / preview.durationSeconds
        : null;
    const triggerRadiusMeters = computeTriggerRadiusMeters(averageSpeedMps);
    const stops = buildFollowAlongStops(
      selectedStories,
      preview.destination,
      preview.distanceMeters,
      triggerRadiusMeters
    );

    let prepared;
    try {
      prepared = await prepareCustomRouteJob({
        admin,
        jamId: body.jamId ?? null,
        city: routeCity,
        transportMode: "drive",
        lengthMinutes: Math.max(20, Math.round(preview.durationSeconds / 60)),
        persona,
        stops,
        source: "follow_along",
        routeTitle: `Follow Along to ${preview.destination.label}`,
        narratorGuidance,
        experienceKind: "follow_along",
        routeMeta: {
          originLabel: preview.origin.label,
          originLat: preview.origin.lat,
          originLng: preview.origin.lng,
          destinationLabel: preview.destination.label,
          destinationLat: preview.destination.lat,
          destinationLng: preview.destination.lng,
          routeDistanceMeters: preview.distanceMeters,
          routeDurationSeconds: preview.durationSeconds,
          routePolyline: preview.routeCoords,
        },
      });
    } catch (e) {
      return NextResponse.json(
        {
          error:
            e instanceof Error
              ? e.message
              : "Failed to create Follow Along route.",
        },
        { status: 400 }
      );
    }

    const narratorVoice =
      prepared.persona === "custom" && prepared.narratorGuidance
        ? selectCustomNarratorVoice(prepared.narratorGuidance)
        : null;

    after(async () => {
      try {
        await runCustomRouteGeneration(
          admin,
          prepared.jobId,
          prepared.routeId,
          prepared.city,
          prepared.transportMode,
          prepared.lengthMinutes,
          prepared.persona,
          prepared.stops,
          prepared.narratorGuidance,
          narratorVoice
        );
      } catch (e) {
        console.error("follow along generation failed", {
          jobId: prepared.jobId,
          routeId: prepared.routeId,
          error: e,
        });
        await admin
          .from("custom_routes")
          .update({ status: "failed" })
          .eq("id", prepared.routeId);
        await admin
          .from("mix_generation_jobs")
          .update({
            status: "failed",
            message: "Generation failed",
            error: e instanceof Error ? e.message : "Unknown error",
          })
          .eq("id", prepared.jobId);
      }
    });

    return NextResponse.json({
      jamId: prepared.jamId,
      routeId: prepared.routeId,
      routeRef: prepared.routeRef,
      jobId: prepared.jobId,
      stopCount: prepared.stops.length,
      preview,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Failed to create Follow Along route.",
      },
      { status: 500 }
    );
  }
}
