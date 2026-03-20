import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PresetCitySeedSchema, PresetMetaSchema, type PresetCitySeed, type PresetMeta, type PresetRoutePricingSeed, type PresetRouteSeed, type PresetStopSeed } from "../lib/presets/schema.ts";

type Persona = "adult" | "preteen" | "ghost";
type PresetContentPriority = "default" | "history_first";
type PresetNarrationBeat = "overview" | "hook" | "reveal" | "contrast" | "payoff";
type PresetTtsVoice = "alloy" | "nova" | "shimmer" | "onyx";

type GeneratedRouteVoice = {
  archetypeId: string;
  displayName?: string;
  basePersona: Persona;
  ttsVoice?: PresetTtsVoice;
  tone?: string[];
  storyLens?: string;
  transitionStyle?: string;
  bannedPatterns?: string[];
  openerFamilies?: string[];
};

type GeneratedStopNarration = {
  beat?: PresetNarrationBeat;
  angle?: string;
  factBullets?: string[];
  mustMention?: string[];
  sensoryTargets?: string[];
  contentPriority?: PresetContentPriority;
};

type CanonicalStopRow = {
  id: string;
  city: string;
  title: string;
  lat: number;
  lng: number;
  image_url: string | null;
  image_source: "places" | "curated" | "placeholder" | "link_seed" | null;
  google_place_id: string | null;
};

type ResolvedPlace = {
  title: string;
  lat: number;
  lng: number;
  googlePlaceId: string;
};

type StopResolved = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  googlePlaceId: string;
  narratorGuidance?: string;
  mustMention?: string[];
  factBullets?: string[];
  narration?: GeneratedStopNarration;
};

type GeneratedRoutePricing = {
  status: "free" | "paid" | "tbd";
  displayLabel?: string;
  amountUsdCents: number | null;
};

type GeneratedRoute = {
  id: string;
  title: string;
  durationLabel: string;
  durationMinutes: number;
  description: string;
  defaultPersona: Persona;
  storyBy?: string;
  narratorGuidance?: string;
  contentPriority?: "default" | "history_first";
  voice?: GeneratedRouteVoice;
  pricing: GeneratedRoutePricing;
  city: string;
  stops: StopResolved[];
};

type PlaceDetailsNewResponse = {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  error?: {
    message?: string;
    status?: string;
  };
};

const ROOT = process.cwd();
const PRESET_DIR = path.join(ROOT, "app/content/presets");
const GENERATED_FILE = path.join(ROOT, "app/content/generated/presetRoutes.generated.ts");
const DIAGNOSTICS_FILE = path.join(ROOT, "app/content/generated/presetRoutes.diagnostics.json");
const ENV_FILE = path.join(ROOT, ".env.local");

const LEGACY_FALLBACK_BY_PLACE_ID: Record<string, StopResolved> = {
  ChIJ_salem_harbor_seed: {
    id: "preset-stop-salem-harbor",
    title: "Salem Harbor",
    lat: 42.5212,
    lng: -70.8877,
    googlePlaceId: "ChIJ_salem_harbor_seed",
  },
  ChIJ_house_of_the_seven_gables_seed: {
    id: "preset-stop-house-seven-gables",
    title: "House of the Seven Gables",
    lat: 42.521756,
    lng: -70.883507,
    googlePlaceId: "ChIJ_house_of_the_seven_gables_seed",
  },
  ChIJ_old_burying_point_seed: {
    id: "preset-stop-old-burying-point",
    title: "Old Burying Point Cemetery",
    lat: 42.5206,
    lng: -70.8922,
    googlePlaceId: "ChIJ_old_burying_point_seed",
  },
  ChIJ_salem_witch_trials_memorial_seed: {
    id: "preset-stop-witch-trials-memorial",
    title: "Salem Witch Trials Memorial",
    lat: 42.5232,
    lng: -70.8958,
    googlePlaceId: "ChIJ_salem_witch_trials_memorial_seed",
  },
  ChIJ_joshua_ward_house_seed: {
    id: "preset-stop-joshua-ward-house",
    title: "Joshua Ward House",
    lat: 42.5203982,
    lng: -70.8959536,
    googlePlaceId: "ChIJ_joshua_ward_house_seed",
  },
  ChIJ_ropes_mansion_garden_seed: {
    id: "preset-stop-ropes-mansion-garden",
    title: "Ropes Mansion & Garden",
    lat: 42.5211,
    lng: -70.8972,
    googlePlaceId: "ChIJ_ropes_mansion_garden_seed",
  },
  ChIJ_salem_witch_house_seed: {
    id: "preset-stop-salem-witch-house",
    title: "Salem Witch House",
    lat: 42.5229,
    lng: -70.8985,
    googlePlaceId: "ChIJ_salem_witch_house_seed",
  },
};

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function makeStopId(city: string, placeId: string, title: string) {
  const candidate = slug(title) || slug(placeId) || "stop";
  return `preset-${city}-${candidate}`;
}

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    check: args.has("--check"),
    allowUnresolved: args.has("--allow-unresolved"),
  };
}

async function loadEnvFromDotLocal() {
  try {
    const raw = await fs.readFile(ENV_FILE, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (!key || process.env[key]) continue;
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // .env.local is optional here; script can still run with shell env vars.
  }
}

function getAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function readPresetSeeds() {
  const entries = await fs.readdir(PRESET_DIR, { withFileTypes: true });
  const routeFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".routes.json"))
    .map((entry) => path.join(PRESET_DIR, entry.name))
    .sort();

  const metaFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"))
    .map((entry) => path.join(PRESET_DIR, entry.name))
    .sort();

  const seeds: PresetCitySeed[] = [];
  const metas = new Map<string, PresetMeta>();

  for (const file of routeFiles) {
    const json = await readJson<unknown>(file);
    seeds.push(PresetCitySeedSchema.parse(json));
  }
  for (const file of metaFiles) {
    const json = await readJson<unknown>(file);
    const parsed = PresetMetaSchema.parse(json);
    metas.set(parsed.city, parsed);
  }

  return { seeds, metas };
}

async function getCanonicalByPlaceId(admin: SupabaseClient, city: string, placeId: string) {
  const { data, error } = await admin
    .from("canonical_stops")
    .select("id,city,title,lat,lng,image_url,image_source,google_place_id")
    .eq("city", city)
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as CanonicalStopRow | null;
}

async function upsertCanonicalFromResolved(
  admin: SupabaseClient,
  city: string,
  placeId: string,
  resolved: ResolvedPlace
): Promise<CanonicalStopRow | null> {
  const { data, error } = await admin
    .from("canonical_stops")
    .upsert(
      {
        id: `canon-place-${slug(city)}-${slug(placeId).slice(0, 32)}`,
        city,
        title: resolved.title,
        lat: resolved.lat,
        lng: resolved.lng,
        source: "preset_seed",
        google_place_id: placeId,
        image_source: "placeholder",
      },
      { onConflict: "id" }
    )
    .select("id,city,title,lat,lng,image_url,image_source,google_place_id")
    .single();

  if (error) {
    console.warn(`Failed to upsert canonical stop for ${city}:${placeId}: ${error.message}`);
    return null;
  }
  return data as CanonicalStopRow;
}

async function resolveFromPlaceDetails(placeId: string): Promise<ResolvedPlace | null> {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return null;

  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "id,displayName,location",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as PlaceDetailsNewResponse;
    if (body.error) return null;
    const resolvedId = (body.id || "").trim();
    const displayName = (body.displayName?.text || "").trim();
    if (!resolvedId || !displayName) return null;

    const lat = Number(body.location?.latitude);
    const lng = Number(body.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      title: displayName,
      lat,
      lng,
      googlePlaceId: resolvedId,
    };
  } catch {
    return null;
  }
}

function normalizeStopSeeds(route: PresetRouteSeed): PresetStopSeed[] {
  if (route.stops?.length) return route.stops;
  return (route.stopPlaceIds ?? []).map((placeId) => ({ placeId }));
}

function buildResolvedStop(city: string, stopSeed: PresetStopSeed, resolvedPlace: ResolvedPlace): StopResolved {
  const title = (stopSeed.title || "").trim() || resolvedPlace.title;
  return {
    id: makeStopId(city, stopSeed.placeId, title),
    title,
    lat: resolvedPlace.lat,
    lng: resolvedPlace.lng,
    googlePlaceId: stopSeed.placeId,
    ...(stopSeed.narratorGuidance ? { narratorGuidance: stopSeed.narratorGuidance } : {}),
    ...(stopSeed.mustMention?.length ? { mustMention: stopSeed.mustMention } : {}),
    ...(stopSeed.factBullets?.length ? { factBullets: stopSeed.factBullets } : {}),
    ...(stopSeed.narration ? { narration: stopSeed.narration } : {}),
  };
}

async function resolvePlace(
  admin: SupabaseClient | null,
  city: string,
  placeId: string,
  diagnostics: { unresolved: Array<{ city: string; placeId: string; reason: string }> }
): Promise<ResolvedPlace | null> {
  if (admin) {
    const canonical = await getCanonicalByPlaceId(admin, city, placeId);
    if (canonical) {
      return {
        title: canonical.title,
        lat: canonical.lat,
        lng: canonical.lng,
        googlePlaceId: placeId,
      };
    }
  }

  const fromPlaces = await resolveFromPlaceDetails(placeId);
  if (fromPlaces) {
    if (admin) await upsertCanonicalFromResolved(admin, city, placeId, fromPlaces);
    return {
      ...fromPlaces,
      googlePlaceId: placeId,
    };
  }

  const fallback = LEGACY_FALLBACK_BY_PLACE_ID[placeId];
  if (fallback) {
    return {
      title: fallback.title,
      lat: fallback.lat,
      lng: fallback.lng,
      googlePlaceId: placeId,
    };
  }

  diagnostics.unresolved.push({ city, placeId, reason: "Not found in canonical_stops and Google Place Details unavailable." });
  return null;
}

function toTsLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeRoutePricing(pricing?: PresetRoutePricingSeed): GeneratedRoutePricing {
  if (!pricing) {
    return {
      status: "tbd",
      amountUsdCents: null,
    };
  }

  return {
    status: pricing.status,
    ...(pricing.displayLabel ? { displayLabel: pricing.displayLabel } : {}),
    amountUsdCents: pricing.amountUsdCents ?? null,
  };
}

async function main() {
  await loadEnvFromDotLocal();
  const { check, allowUnresolved } = parseArgs();
  const admin = getAdmin();

  const { seeds, metas } = await readPresetSeeds();
  const globalRouteIds = new Set<string>();
  for (const seed of seeds) {
    for (const route of seed.routes) {
      if (globalRouteIds.has(route.id)) {
        throw new Error(`Duplicate route id across city seeds: ${route.id}`);
      }
      globalRouteIds.add(route.id);
    }
  }

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    unresolved: [] as Array<{ city: string; placeId: string; reason: string }>,
  };

  const generatedRoutes: GeneratedRoute[] = [];

  for (const seed of seeds) {
    for (const route of seed.routes) {
      const resolvedStops: StopResolved[] = [];
      const stopSeeds = normalizeStopSeeds(route);
      for (const stopSeed of stopSeeds) {
        const resolvedPlace = await resolvePlace(admin, seed.city, stopSeed.placeId, diagnostics);
        if (!resolvedPlace) continue;
        resolvedStops.push(buildResolvedStop(seed.city, stopSeed, resolvedPlace));
      }

      if (resolvedStops.length === 0) {
        throw new Error(`Route ${route.id} resolved zero stops.`);
      }

      const stopIds = new Set<string>();
      for (const stop of resolvedStops) {
        if (stopIds.has(stop.id)) {
          throw new Error(`Route ${route.id} produced duplicate stop id: ${stop.id}`);
        }
        stopIds.add(stop.id);
      }

      generatedRoutes.push({
        id: route.id,
        title: route.title,
        durationLabel: `${route.durationMinutes} mins`,
        durationMinutes: route.durationMinutes,
        description: route.description,
        defaultPersona: route.defaultPersona,
        ...(route.storyBy ? { storyBy: route.storyBy } : {}),
        ...(route.narratorGuidance ? { narratorGuidance: route.narratorGuidance } : {}),
        ...(route.contentPriority ? { contentPriority: route.contentPriority } : {}),
        ...(route.voice ? { voice: route.voice } : {}),
        pricing: normalizeRoutePricing(route.pricing),
        city: seed.city,
        stops: resolvedStops,
      });
    }
  }

  if (!allowUnresolved && diagnostics.unresolved.length > 0) {
    throw new Error(`Found ${diagnostics.unresolved.length} unresolved place IDs. Re-run with --allow-unresolved to emit diagnostics only.`);
  }

  const generatedPayload = {
    generatedAt: diagnostics.generatedAt,
    cities: Array.from(new Set(seeds.map((seed) => seed.city))).sort(),
    routes: generatedRoutes,
    cityMeta: Object.fromEntries(Array.from(metas.entries()).map(([city, meta]) => [city, meta.overview])),
  };

  const source = `// AUTO-GENERATED FILE. DO NOT EDIT BY HAND.\n// Generated by scripts/buildPresetRoutes.ts\n\nexport const presetRouteData = ${toTsLiteral(generatedPayload)} as const;\n`;

  if (!check) {
    await fs.writeFile(GENERATED_FILE, source, "utf8");
    await fs.writeFile(DIAGNOSTICS_FILE, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  }

  console.log(
    JSON.stringify(
      {
        check,
        routes: generatedRoutes.length,
        unresolved: diagnostics.unresolved.length,
        output: GENERATED_FILE,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
