import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { StopInput } from "@/lib/mixGeneration";
import { resolveNearbyPlaces } from "@/lib/nearbyPlaceResolver";
import { proxyGoogleImageUrl } from "@/lib/placesImages";

type Body = {
  jamId?: string | null;
  lat: number;
  lng: number;
  city?: string | null;
  minStops?: number;
  maxStops?: number;
  minSpreadMeters?: number;
};

type GeocodeResult = {
  address_components?: Array<{
    long_name?: string;
    short_name?: string;
    types?: string[];
  }>;
};

type GeocodeResponse = {
  status?: string;
  results?: GeocodeResult[];
};

const MAX_STOPS_LIMIT = 9;
const MIN_STOPS_LIMIT = 1;
const DEFAULT_MAX_STOPS = 9;
const DEFAULT_MIN_STOPS = 1;
const NEARBY_RADIUS_METERS = 500;
const NEARBY_RADIUS_EXPANDED_METERS = 1500;
const MIN_STOP_SPREAD_METERS = 40;
const MAX_STOP_SPREAD_METERS = 500;
const GOOGLE_GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

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

function parseCount(value: number | undefined, fallback: number) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseSpreadMeters(value: number | undefined, fallback: number) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, 0, MAX_STOP_SPREAD_METERS);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeCity(city: string | null | undefined) {
  const normalized = (city || "").trim().toLowerCase();
  return normalized || "nearby";
}

function formatCoord(value: number) {
  return Number(value).toFixed(5);
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const avgLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(avgLatRad);
  const dLat = (aLat - bLat) * metersPerLat;
  const dLng = (aLng - bLng) * metersPerLng;
  return Math.hypot(dLat, dLng);
}

function normalizeCityName(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

async function inferCityFromCoords(lat: number, lng: number): Promise<string | null> {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return null;
  try {
    const params = new URLSearchParams({
      latlng: `${lat},${lng}`,
      result_type: "locality|postal_town|administrative_area_level_2",
      key: apiKey,
    });
    const res = await fetch(`${GOOGLE_GEOCODE_ENDPOINT}?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const payload = (await res.json()) as GeocodeResponse;
    if (!Array.isArray(payload.results) || payload.results.length === 0) return null;
    const first = payload.results[0];
    const components = first.address_components ?? [];
    const preferred = components.find((component) =>
      (component.types ?? []).some((type) => type === "locality" || type === "postal_town")
    );
    if (preferred?.long_name) return normalizeCityName(preferred.long_name);
    const fallback = components.find((component) =>
      (component.types ?? []).includes("administrative_area_level_2")
    );
    return fallback?.long_name ? normalizeCityName(fallback.long_name) : null;
  } catch {
    return null;
  }
}

function selectWithMinSpread<T extends { lat: number; lng: number }>(items: T[], maxStops: number, minSpreadMeters: number) {
  const selected: T[] = [];
  for (const item of items) {
    if (selected.length >= maxStops) break;
    const tooClose = selected.some((existing) => distanceMeters(existing.lat, existing.lng, item.lat, item.lng) < minSpreadMeters);
    if (tooClose) continue;
    selected.push(item);
  }
  return selected;
}

function mergeWithFallbackSpread<T extends { id: string; lat: number; lng: number }>(
  spreadSelected: T[],
  ranked: T[],
  maxStops: number
) {
  const merged = [...spreadSelected];
  for (const candidate of ranked) {
    if (merged.length >= maxStops) break;
    if (merged.some((existing) => existing.id === candidate.id)) continue;
    merged.push(candidate);
  }
  return merged;
}

export async function POST(req: Request) {
  if (!isNearbyStoryEnabled()) {
    return NextResponse.json({ error: "Nearby story feature is disabled." }, { status: 404 });
  }

  try {
    const body = (await req.json()) as Body;
    void body.jamId;

    if (!isFiniteCoord(body.lat) || !isFiniteCoord(body.lng) || Math.abs(body.lat) > 90) {
      return NextResponse.json({ error: "Valid geolocation is required." }, { status: 400 });
    }

    const requestedMax = parseCount(body.maxStops, DEFAULT_MAX_STOPS);
    const maxStops = clamp(requestedMax, MIN_STOPS_LIMIT, MAX_STOPS_LIMIT);
    const requestedMin = parseCount(body.minStops, DEFAULT_MIN_STOPS);
    const minStops = clamp(requestedMin, MIN_STOPS_LIMIT, maxStops);
    const minSpreadMeters = parseSpreadMeters(body.minSpreadMeters, MIN_STOP_SPREAD_METERS);
    const cityHint = normalizeCity(body.city);
    const inferredCity = await inferCityFromCoords(body.lat, body.lng);
    const cityUsed = inferredCity || cityHint;

    let searchRadiusMeters = NEARBY_RADIUS_METERS;
    let resolved = await resolveNearbyPlaces({
      admin: getAdmin(),
      city: cityUsed,
      lat: body.lat,
      lng: body.lng,
      radiusMeters: searchRadiusMeters,
      maxCandidates: maxStops,
      googleOnly: true,
    });

    if (resolved.candidates.length < Math.min(3, maxStops)) {
      searchRadiusMeters = NEARBY_RADIUS_EXPANDED_METERS;
      resolved = await resolveNearbyPlaces({
        admin: getAdmin(),
        city: cityUsed,
        lat: body.lat,
        lng: body.lng,
        radiusMeters: searchRadiusMeters,
        maxCandidates: maxStops,
        googleOnly: true,
      });
    }

    if (resolved.candidates.length === 0) {
      const debug = {
        cityUsed,
        radiusMeters: searchRadiusMeters,
        lat: formatCoord(body.lat),
        lng: formatCoord(body.lng),
        googlePlacesKeyConfigured: !resolved.missingGooglePlacesKey,
        googleNearbyStatus: resolved.googleNearbyStatus,
        googleNearbyHttpStatus: resolved.googleNearbyHttpStatus,
      };
      if (resolved.missingGooglePlacesKey) {
        return NextResponse.json(
          {
            error: "Google Nearby lookup is unavailable because GOOGLE_PLACES_API_KEY is not configured.",
            debug,
          },
          { status: 404 }
        );
      }
      return NextResponse.json(
        {
          error:
            `No nearby notable place found within ${searchRadiusMeters}m ` +
            `(city="${cityUsed}", lat=${formatCoord(body.lat)}, lng=${formatCoord(body.lng)}). ` +
            "Likely causes: Places Nearby API not enabled, key restrictions (HTTP referrer/IP), quota/billing limits, or sparse nearby POIs.",
          debug,
        },
        { status: 404 }
      );
    }

    const spreadSelected = selectWithMinSpread(resolved.candidates, maxStops, minSpreadMeters);
    const selected = mergeWithFallbackSpread(spreadSelected, resolved.candidates, maxStops);
    if (selected.length < minStops) {
      return NextResponse.json(
        {
          error: `Only ${selected.length} nearby place(s) found; at least ${minStops} required.`,
        },
        { status: 404 }
      );
    }

    const stops: StopInput[] = selected.map((candidate, idx) => ({
      id: `nearby-auto-${idx + 1}-${candidate.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
      title: candidate.title,
      lat: candidate.lat,
      lng: candidate.lng,
      image: proxyGoogleImageUrl(candidate.image) || candidate.image,
      googlePlaceId: candidate.googlePlaceId ?? undefined,
    }));

    const sourceSummary = selected.reduce<Record<string, number>>((acc, candidate) => {
      acc[candidate.source] = (acc[candidate.source] || 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({ stops, cityUsed, sourceSummary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to resolve nearby places." }, { status: 500 });
  }
}
