import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

export type GoogleMapsLibraries = {
  Map: typeof google.maps.Map;
  InfoWindow: typeof google.maps.InfoWindow;
  Polyline: typeof google.maps.Polyline;
  LatLngBounds: typeof google.maps.LatLngBounds;
};

export type GoogleLegacyRoutesLibrary = {
  DirectionsService: typeof google.maps.DirectionsService;
};

let googleMapsLibrariesPromise: Promise<GoogleMapsLibraries> | null = null;
let googleLegacyRoutesPromise: Promise<GoogleLegacyRoutesLibrary> | null = null;
let configuredGoogleMapsKey: string | null = null;

function ensureGoogleMapsConfigured() {
  const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.");
  }

  if (configuredGoogleMapsKey && configuredGoogleMapsKey !== apiKey) {
    throw new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY changed after Google Maps was initialized.");
  }

  if (!configuredGoogleMapsKey) {
    configuredGoogleMapsKey = apiKey;
    setOptions({ key: apiKey, v: "weekly" });
  }
}

export function loadGoogleMapsLibraries(): Promise<GoogleMapsLibraries> {
  ensureGoogleMapsConfigured();

  if (!googleMapsLibrariesPromise) {
    googleMapsLibrariesPromise = Promise.all([
      importLibrary("core"),
      importLibrary("maps"),
    ]).then(([coreLibrary, mapsLibrary]) => ({
      Map: mapsLibrary.Map,
      InfoWindow: mapsLibrary.InfoWindow,
      Polyline: mapsLibrary.Polyline,
      LatLngBounds: coreLibrary.LatLngBounds,
    }));
  }

  return googleMapsLibrariesPromise;
}

export function loadGoogleLegacyRoutesLibrary(): Promise<GoogleLegacyRoutesLibrary> {
  ensureGoogleMapsConfigured();

  if (!googleLegacyRoutesPromise) {
    googleLegacyRoutesPromise = importLibrary("routes").then((routesLibrary) => ({
      DirectionsService: routesLibrary.DirectionsService,
    }));
  }

  return googleLegacyRoutesPromise;
}
