import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

export type GoogleMapsLibraries = {
  Map: typeof google.maps.Map;
  InfoWindow: typeof google.maps.InfoWindow;
  Polyline: typeof google.maps.Polyline;
  LatLngBounds: typeof google.maps.LatLngBounds;
  AdvancedMarkerElement: typeof google.maps.marker.AdvancedMarkerElement;
};

export type GoogleRoutesLibrary = {
  Route: typeof google.maps.routes.Route;
};

let googleMapsLibrariesPromise: Promise<GoogleMapsLibraries> | null = null;
let googleRoutesPromise: Promise<GoogleRoutesLibrary> | null = null;
let configuredGoogleMapsKey: string | null = null;
let configuredGoogleMapsMapId: string | null = null;

function ensureGoogleMapsConfigured() {
  const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "").trim();
  const mapId = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "").trim();
  if (!apiKey) {
    throw new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.");
  }
  if (!mapId) {
    throw new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID.");
  }

  if (configuredGoogleMapsKey && configuredGoogleMapsKey !== apiKey) {
    throw new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY changed after Google Maps was initialized.");
  }
  if (configuredGoogleMapsMapId && configuredGoogleMapsMapId !== mapId) {
    throw new Error("NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID changed after Google Maps was initialized.");
  }

  if (!configuredGoogleMapsKey) {
    configuredGoogleMapsKey = apiKey;
    configuredGoogleMapsMapId = mapId;
    setOptions({ key: apiKey, mapIds: [mapId], v: "weekly" });
  }
}

export function getGoogleMapsMapId() {
  ensureGoogleMapsConfigured();
  return configuredGoogleMapsMapId!;
}

export function loadGoogleMapsLibraries(): Promise<GoogleMapsLibraries> {
  ensureGoogleMapsConfigured();

  if (!googleMapsLibrariesPromise) {
    googleMapsLibrariesPromise = Promise.all([
      importLibrary("core"),
      importLibrary("maps"),
      importLibrary("marker"),
    ]).then(([coreLibrary, mapsLibrary, markerLibrary]) => ({
      Map: mapsLibrary.Map,
      InfoWindow: mapsLibrary.InfoWindow,
      Polyline: mapsLibrary.Polyline,
      LatLngBounds: coreLibrary.LatLngBounds,
      AdvancedMarkerElement: markerLibrary.AdvancedMarkerElement,
    }));
  }

  return googleMapsLibrariesPromise;
}

export function loadGoogleRoutesLibrary(): Promise<GoogleRoutesLibrary> {
  ensureGoogleMapsConfigured();

  if (!googleRoutesPromise) {
    googleRoutesPromise = importLibrary("routes").then((routesLibrary) => ({
      Route: (routesLibrary as google.maps.RoutesLibrary & GoogleRoutesLibrary).Route,
    }));
  }

  return googleRoutesPromise;
}
