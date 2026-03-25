import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { DiscoveryTheme } from "@/app/content/routeTypes";
import {
  createWalkDiscoverySuggestion,
  type WalkDiscoveryPositionSample,
} from "@/lib/walkDiscovery";
import { normalizePresetCity } from "@/lib/presetOverview";
import { loadJourneyRouteStopsForWalkDiscovery } from "@/lib/server/walkDiscovery";
import { countAcceptedWalkDiscoveryStops } from "@/lib/server/walkDiscoveryPurchases";
import { resolveWalkDiscoverySuggestionPricing } from "@/lib/server/walkDiscoveryPricing";
import { resolveWalkDiscoverySuggestion } from "@/lib/server/walkDiscoverySuggestions";

type Body = {
  jamId?: string | null;
  lat: number;
  lng: number;
  recentPositions?: WalkDiscoveryPositionSample[];
  acceptedCandidateKeys?: string[];
  cooldownCandidateKeys?: string[];
  city?: string | null;
  discoveryThemes?: DiscoveryTheme[] | null;
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

function normalizeKeys(values: string[] | undefined) {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!isFiniteCoord(body.lat) || !isFiniteCoord(body.lng) || Math.abs(body.lat) > 90) {
      return NextResponse.json({ error: "Valid geolocation is required." }, { status: 400 });
    }

    const admin = getAdmin();
    const jamId = body.jamId?.trim() || null;
    const cityHint = body.city ? normalizePresetCity(body.city) : null;
    const existingRouteStops = jamId
      ? await loadJourneyRouteStopsForWalkDiscovery(admin, jamId, cityHint)
      : [];
    const candidate = await resolveWalkDiscoverySuggestion({
      admin,
      lat: body.lat,
      lng: body.lng,
      recentPositions: Array.isArray(body.recentPositions) ? body.recentPositions : [],
      excludedCandidateKeys: [
        ...normalizeKeys(body.acceptedCandidateKeys),
        ...normalizeKeys(body.cooldownCandidateKeys),
      ],
      existingRouteStops,
      city: body.city,
      discoveryThemes: Array.isArray(body.discoveryThemes) ? body.discoveryThemes : [],
    });

    if (!candidate) {
      return NextResponse.json({ suggestion: null });
    }

    const pricing = resolveWalkDiscoverySuggestionPricing({
      acceptedStopCount: jamId
        ? await countAcceptedWalkDiscoveryStops(admin, jamId)
        : 0,
      purchaseKey: randomUUID(),
    });

    return NextResponse.json({
      suggestion: createWalkDiscoverySuggestion(candidate, Date.now(), pricing),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to suggest nearby stop.",
      },
      { status: 500 }
    );
  }
}
