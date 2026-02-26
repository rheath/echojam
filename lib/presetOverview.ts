import type { Stop } from "@/app/content/salemRoutes";
import type { StopInput } from "@/lib/mixGeneration";

export type PresetCity = "salem" | "boston" | "concord";

type CityMeta = {
  label: string;
  lat: number;
  lng: number;
};

const CITY_META: Record<PresetCity, CityMeta> = {
  salem: { label: "Salem", lat: 42.5195, lng: -70.8967 },
  boston: { label: "Boston", lat: 42.3601, lng: -71.0589 },
  concord: { label: "Concord", lat: 42.4604, lng: -71.3489 },
};

export function normalizePresetCity(city: string | null | undefined): PresetCity {
  if (city === "boston" || city === "concord" || city === "salem") return city;
  return "salem";
}

export function getPresetCityMeta(city: PresetCity) {
  return CITY_META[city];
}

export function getPresetOverviewStopId(city: PresetCity) {
  return `preset-overview-${city}`;
}

export function isPresetOverviewStopId(stopId: string) {
  return stopId.startsWith("preset-overview-");
}

export function buildPresetOverviewStop(city: PresetCity): StopInput & { isOverview: true } {
  const meta = getPresetCityMeta(city);
  return {
    id: getPresetOverviewStopId(city),
    title: `Overview of ${meta.label}`,
    lat: meta.lat,
    lng: meta.lng,
    image: "/images/salem/placeholder-01.png",
    isOverview: true,
  };
}

export function buildPresetStopsWithOverview(routeStops: Stop[], city: PresetCity): Array<StopInput & { isOverview?: boolean }> {
  const overview = buildPresetOverviewStop(city);
  const mappedStops = routeStops.map((stop) => ({
    id: stop.id,
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    image: stop.images[0] ?? "/images/salem/placeholder-01.png",
    isOverview: false,
  }));
  return [overview, ...mappedStops];
}
