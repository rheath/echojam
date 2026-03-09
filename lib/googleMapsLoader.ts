import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

export type GoogleMapsLibraries = {
  Map: typeof google.maps.Map;
  InfoWindow: typeof google.maps.InfoWindow;
  Polyline: typeof google.maps.Polyline;
  Marker: typeof google.maps.Marker;
  LatLngBounds: typeof google.maps.LatLngBounds;
  DirectionsService: typeof google.maps.DirectionsService;
};

let googleMapsLibrariesPromise: Promise<GoogleMapsLibraries> | null = null;
let configuredGoogleMapsKey: string | null = null;

export function loadGoogleMapsLibraries(): Promise<GoogleMapsLibraries> {
  const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.");
  }

  if (configuredGoogleMapsKey && configuredGoogleMapsKey !== apiKey) {
    throw new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY changed after Google Maps was initialized.");
  }

  if (!googleMapsLibrariesPromise) {
    configuredGoogleMapsKey = apiKey;
    setOptions({ key: apiKey, v: "weekly" });
    googleMapsLibrariesPromise = Promise.all([
      importLibrary("core"),
      importLibrary("maps"),
      importLibrary("marker"),
      importLibrary("routes"),
    ]).then(([coreLibrary, mapsLibrary, markerLibrary, routesLibrary]) => ({
      Map: mapsLibrary.Map,
      InfoWindow: mapsLibrary.InfoWindow,
      Polyline: mapsLibrary.Polyline,
      Marker: markerLibrary.Marker,
      LatLngBounds: coreLibrary.LatLngBounds,
      DirectionsService: routesLibrary.DirectionsService,
    }));
  }

  return googleMapsLibrariesPromise;
}
