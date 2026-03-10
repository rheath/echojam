import { presetRouteData } from "@/app/content/generated/presetRoutes.generated";

export type FixedPersona = "adult" | "preteen" | "ghost";
export type Persona = FixedPersona | "custom";
export type PresetCity = "salem" | "boston" | "concord" | "nyc";
export type RoutePricing = {
  status: "free" | "paid" | "tbd";
  displayLabel?: string;
  amountUsdCents?: number | null;
};

export type Stop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  googlePlaceId?: string;
  isOverview?: boolean;
  stopKind?: "story" | "arrival";
  distanceAlongRouteMeters?: number | null;
  triggerRadiusMeters?: number | null;
  audio: Record<Persona, string>;
  text?: Record<Persona, string>;
  images: string[];
};

export type RouteDef = {
  id: string;
  title: string;
  durationLabel: string;
  durationMinutes?: number;
  description: string;
  defaultPersona: Persona;
  pricing?: RoutePricing;
  city?: PresetCity;
  transportMode?: "walk" | "drive";
  experienceKind?: "preset" | "mix" | "follow_along";
  routePathCoords?: [number, number][] | null;
  origin?: { lat: number; lng: number; label: string; subtitle?: string | null } | null;
  destination?: { lat: number; lng: number; label: string; subtitle?: string | null } | null;
  routeDistanceMeters?: number | null;
  routeDurationSeconds?: number | null;
  stops: Stop[];
};

const DEFAULT_PLACEHOLDER = "/images/salem/placeholder.png";

function mapRoute(route: (typeof presetRouteData.routes)[number]): RouteDef {
  return {
    id: route.id,
    title: route.title,
    durationLabel: route.durationLabel,
    durationMinutes: route.durationMinutes,
    description: route.description,
    defaultPersona: route.defaultPersona,
    pricing: route.pricing,
    city: route.city,
    transportMode: "walk",
    experienceKind: "preset",
    routePathCoords: null,
    origin: null,
    destination: null,
    routeDistanceMeters: null,
    routeDurationSeconds: null,
    stops: route.stops.map((stop) => ({
      id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      googlePlaceId: stop.googlePlaceId,
      audio: { adult: "", preteen: "", ghost: "", custom: "" },
      images: [DEFAULT_PLACEHOLDER],
      stopKind: "story",
      distanceAlongRouteMeters: null,
      triggerRadiusMeters: null,
    })),
  };
}

export const presetRoutes: RouteDef[] = presetRouteData.routes.map(mapRoute);

export function getPresetRoutesByCity(city: PresetCity): RouteDef[] {
  return presetRoutes.filter((route) => route.city === city);
}

export const salemRoutes: RouteDef[] = getPresetRoutesByCity("salem");

export function getRouteById(routeId: string | null | undefined): RouteDef | null {
  if (!routeId) return null;
  const route = presetRouteData.routes.find((candidate) => candidate.id === routeId);
  if (!route) return null;
  return mapRoute(route);
}
