import type { PresetCity, PresetContentPriority, Stop } from "@/app/content/salemRoutes";
import type { StopInput } from "@/lib/mixGeneration";
import { presetRouteData } from "@/app/content/generated/presetRoutes.generated";

type CityMeta = {
  label: string;
  lat: number;
  lng: number;
  fallbackImage: string;
};

const FALLBACK_CITY_META: Record<PresetCity, CityMeta> = {
  salem: { label: "Salem", lat: 42.5195, lng: -70.8967, fallbackImage: "/images/salem/placeholder.png" },
  boston: { label: "Boston", lat: 42.3601, lng: -71.0589, fallbackImage: "/images/salem/placeholder.png" },
  concord: { label: "Concord", lat: 42.4604, lng: -71.3489, fallbackImage: "/images/salem/placeholder.png" },
  nyc: { label: "New York City", lat: 40.7527, lng: -73.9772, fallbackImage: "/images/salem/placeholder.png" },
};

const GENERATED_CITY_META = presetRouteData.cityMeta as Partial<
  Record<PresetCity, { label: string; lat: number; lng: number; fallbackImage: string }>
>;

export function normalizePresetCity(city: string | null | undefined): PresetCity {
  if (city === "boston" || city === "concord" || city === "nyc" || city === "salem") return city;
  return "salem";
}

export function getPresetCityMeta(city: PresetCity) {
  const generated = GENERATED_CITY_META[city];
  if (generated) {
    return {
      label: generated.label,
      lat: generated.lat,
      lng: generated.lng,
      fallbackImage: generated.fallbackImage || FALLBACK_CITY_META[city].fallbackImage,
    };
  }
  return FALLBACK_CITY_META[city];
}

export function getPresetOverviewStopId(city: PresetCity) {
  return `preset-overview-${city}`;
}

export function isPresetOverviewStopId(stopId: string) {
  return stopId.startsWith("preset-overview-");
}

export function buildPresetOverviewStop(
  city: PresetCity,
  contentPriority?: PresetContentPriority | null
): StopInput & { isOverview: true } {
  const meta = getPresetCityMeta(city);
  return {
    id: getPresetOverviewStopId(city),
    title: `Overview of ${meta.label}`,
    lat: meta.lat,
    lng: meta.lng,
    image: meta.fallbackImage,
    contentPriority: contentPriority ?? null,
    isOverview: true,
  };
}

export function buildPresetStopsWithOverview(
  routeStops: Stop[],
  city: PresetCity,
  routeContentPriority?: PresetContentPriority | null
): Array<StopInput & { isOverview?: boolean }> {
  const overview = buildPresetOverviewStop(city, routeContentPriority);
  const mappedStops = routeStops.map((stop) => ({
    id: stop.id,
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    image: "/images/salem/placeholder.png",
    googlePlaceId: stop.googlePlaceId,
    narratorGuidance: stop.narratorGuidance ?? null,
    mustMention: stop.mustMention ?? null,
    factBullets: stop.factBullets ?? null,
    contentPriority: stop.contentPriority ?? routeContentPriority ?? null,
    isOverview: false,
  }));
  return [overview, ...mappedStops];
}
