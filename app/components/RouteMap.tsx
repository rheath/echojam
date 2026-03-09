"use client";

import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { useEffect, useRef, useState } from "react";
import styles from "./RouteMap.module.css";

type Stop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  isOverview?: boolean;
  stopKind?: "story" | "arrival";
  images?: string[];
};

type Endpoint = {
  lat: number;
  lng: number;
  label: string;
};

type Props = {
  stops: Stop[];
  currentStopIndex: number;
  myPos?: { lat: number; lng: number } | null;
  cityCenter?: { lat: number; lng: number } | null;
  followCurrentStop?: boolean;
  initialFitRoute?: boolean;
  spreadOverlappingStops?: boolean;
  routeCoords?: [number, number][] | null;
  routeTravelMode?: "walk" | "drive" | null;
  showRoutePath?: boolean;
  endpoints?: {
    origin?: Endpoint | null;
    destination?: Endpoint | null;
  } | null;
};

type RouteStatus = "loading" | "ready" | "failed";
type StopVisualStatus = "visited" | "current" | "upcoming" | "arrival";
type DisplayStop = {
  id: string;
  title: string;
  image: string;
  subtitle: string;
  label: string;
  status: StopVisualStatus;
  lat: number;
  lng: number;
};
type GoogleMapsLibraries = {
  Map: typeof google.maps.Map;
  InfoWindow: typeof google.maps.InfoWindow;
  Polyline: typeof google.maps.Polyline;
  Marker: typeof google.maps.Marker;
  LatLngBounds: typeof google.maps.LatLngBounds;
  DirectionsService: typeof google.maps.DirectionsService;
};

const DEFAULT_CENTER = { lat: 42.5195, lng: -70.8967 };
const ROUTE_LINE_COLOR = "#2b1b3f";
const ROUTE_LINE_UNDERLAY = "#ffffff";
const CURRENT_STOP_COLOR = "#ff5f92";
const ARRIVAL_COLOR = "#2e78ff";
const VISITED_COLOR = "#8e93a3";
const UPCOMING_COLOR = "#2b1b3f";
const USER_COLOR = "#2e78ff";
const ORIGIN_COLOR = "#111111";
const MINIMAL_TOURISM_MAP_STYLES: google.maps.MapTypeStyle[] = [
  {
    elementType: "geometry",
    stylers: [{ color: "#f4f4f1" }],
  },
  {
    elementType: "labels.text.fill",
    stylers: [{ color: "#4a4a4a" }],
  },
  {
    elementType: "labels.text.stroke",
    stylers: [{ color: "#f4f4f1" }],
  },
  {
    featureType: "administrative",
    elementType: "geometry.stroke",
    stylers: [{ color: "#d3d3d3" }],
  },
  {
    featureType: "landscape.man_made",
    elementType: "geometry",
    stylers: [{ color: "#ecece8" }],
  },
  {
    featureType: "poi",
    elementType: "labels.icon",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "poi.business",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "poi.medical",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "poi.school",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#ffffff" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#dddddd" }],
  },
  {
    featureType: "road.local",
    elementType: "labels",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "transit",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#d9d9d9" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#666666" }],
  },
];

let googleMapsLibrariesPromise: Promise<GoogleMapsLibraries> | null = null;
let configuredGoogleMapsKey: string | null = null;

function loadGoogleMapsLibraries(): Promise<GoogleMapsLibraries> {
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

export default function RouteMap({
  stops,
  currentStopIndex,
  myPos,
  cityCenter,
  followCurrentStop = true,
  initialFitRoute = false,
  spreadOverlappingStops = false,
  routeCoords: providedRouteCoords = null,
  routeTravelMode = null,
  showRoutePath = false,
  endpoints = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const stopMarkersRef = useRef<google.maps.Marker[]>([]);
  const endpointMarkersRef = useRef<google.maps.Marker[]>([]);
  const meMarkerRef = useRef<google.maps.Marker | null>(null);
  const routeLineRef = useRef<google.maps.Polyline | null>(null);
  const routeLineUnderlayRef = useRef<google.maps.Polyline | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(providedRouteCoords);
  const [routeStatus, setRouteStatus] = useState<RouteStatus>("loading");
  const [initialView] = useState(() => {
    const first = stops[0] ?? endpoints?.origin ?? myPos ?? cityCenter ?? DEFAULT_CENTER;
    return {
      lat: first.lat,
      lng: first.lng,
      zoom: stops.length ? 15 : 13,
    };
  });

  useEffect(() => {
    let cancelled = false;

    async function loadWalkingRoute() {
      if (providedRouteCoords?.length) {
        setRouteCoords(providedRouteCoords);
        setRouteStatus("ready");
        return;
      }

      if (!showRoutePath || routeTravelMode !== "walk") {
        setRouteCoords(null);
        setRouteStatus("failed");
        return;
      }

      setRouteStatus("loading");
      if (stops.length < 2) {
        setRouteCoords(null);
        setRouteStatus("failed");
        return;
      }

      try {
        const { DirectionsService } = await loadGoogleMapsLibraries();
        const directions = new DirectionsService();
        const result = await directions.route({
          origin: { lat: stops[0].lat, lng: stops[0].lng },
          destination: {
            lat: stops[stops.length - 1].lat,
            lng: stops[stops.length - 1].lng,
          },
          waypoints: stops.slice(1, -1).map((stop) => ({
            location: { lat: stop.lat, lng: stop.lng },
            stopover: true,
          })),
          optimizeWaypoints: false,
          travelMode: google.maps.TravelMode.WALKING,
        });

        if (cancelled) return;
        const coords =
          result.routes?.[0]?.overview_path?.map(
            (point) => [point.lng(), point.lat()] as [number, number]
          ) ?? [];

        if (coords.length > 1) {
          setRouteCoords(coords);
          setRouteStatus("ready");
          return;
        }
      } catch (error) {
        console.error("Walking route lookup failed.", error);
      }

      if (!cancelled) {
        setRouteCoords(null);
        setRouteStatus("failed");
      }
    }

    void loadWalkingRoute();

    return () => {
      cancelled = true;
    };
  }, [providedRouteCoords, routeTravelMode, showRoutePath, stops]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!containerRef.current || mapRef.current) return;

      try {
        const { Map, InfoWindow } = await loadGoogleMapsLibraries();
        if (cancelled || !containerRef.current) return;

        const map = new Map(containerRef.current, {
          center: { lat: initialView.lat, lng: initialView.lng },
          zoom: initialView.zoom,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          gestureHandling: "greedy",
          styles: MINIMAL_TOURISM_MAP_STYLES,
        });

        mapRef.current = map;
        infoWindowRef.current = new InfoWindow({ disableAutoPan: false });
        setIsMapReady(true);
      } catch (error) {
        console.error("Google Maps failed to initialize.", error);
        setIsMapReady(false);
      }
    }

    void init();

    return () => {
      cancelled = true;
      setIsMapReady(false);
      clearMarkers(stopMarkersRef.current);
      clearMarkers(endpointMarkersRef.current);
      clearMarker(meMarkerRef.current);
      clearPolyline(routeLineRef.current);
      clearPolyline(routeLineUnderlayRef.current);
      stopMarkersRef.current = [];
      endpointMarkersRef.current = [];
      meMarkerRef.current = null;
      routeLineRef.current = null;
      routeLineUnderlayRef.current = null;
      infoWindowRef.current?.close();
      infoWindowRef.current = null;
      mapRef.current = null;
    };
  }, [initialView]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const displayStops = buildDisplayStops(stops, currentStopIndex, spreadOverlappingStops);
    const visibleRouteCoords = resolveVisibleRouteCoords(
      stops,
      showRoutePath ? routeCoords : null,
      showRoutePath ? routeStatus : "loading"
    );

    clearMarkers(stopMarkersRef.current);
    stopMarkersRef.current = displayStops.map((stop, idx) => {
      const marker = new google.maps.Marker({
        map,
        position: { lat: stop.lat, lng: stop.lng },
        title: stop.title,
        icon: buildStopMarkerIcon(stop.status),
        label: {
          text: stop.label,
          color: stop.status === "current" ? "#111111" : "#ffffff",
          fontSize: "12px",
          fontWeight: "700",
        },
        zIndex: stop.status === "current" ? 30 : 20 + idx,
      });

      marker.addListener("click", () => {
        const infoWindow = infoWindowRef.current;
        if (!infoWindow) return;
        infoWindow.setContent(buildStopPopupContent(stop.title, stop.subtitle, stop.image));
        infoWindow.open({ map, anchor: marker });
      });

      return marker;
    });

    clearMarkers(endpointMarkersRef.current);
    endpointMarkersRef.current = buildEndpointMarkers(map, endpoints);

    clearMarker(meMarkerRef.current);
    meMarkerRef.current = myPos
      ? new google.maps.Marker({
          map,
          position: myPos,
          clickable: false,
          zIndex: 10,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: USER_COLOR,
            fillOpacity: 0.9,
            strokeColor: "#ffffff",
            strokeWeight: 2,
            scale: 6,
          },
        })
      : null;

    clearPolyline(routeLineUnderlayRef.current);
    clearPolyline(routeLineRef.current);
    routeLineUnderlayRef.current = null;
    routeLineRef.current = null;

    if (visibleRouteCoords.length > 1) {
      const path = visibleRouteCoords.map(([lng, lat]) => ({ lat, lng }));
      routeLineUnderlayRef.current = new google.maps.Polyline({
        map,
        path,
        clickable: false,
        geodesic: true,
        strokeColor: ROUTE_LINE_UNDERLAY,
        strokeOpacity: 0.8,
        strokeWeight: 8,
        zIndex: 1,
      });
      routeLineRef.current = new google.maps.Polyline({
        map,
        path,
        clickable: false,
        geodesic: true,
        strokeColor: ROUTE_LINE_COLOR,
        strokeOpacity: 0.9,
        strokeWeight: 5,
        zIndex: 2,
      });
    }
  }, [
    currentStopIndex,
    endpoints,
    isMapReady,
    myPos,
    routeCoords,
    routeStatus,
    showRoutePath,
    spreadOverlappingStops,
    stops,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (initialFitRoute && currentStopIndex <= 0) {
      fitMapToRoute(map, routeCoords, stops, endpoints);
      return;
    }

    if (!followCurrentStop) return;
    const currentStop = stops[currentStopIndex];
    if (currentStop) {
      map.panTo({ lat: currentStop.lat, lng: currentStop.lng });
    }
  }, [currentStopIndex, endpoints, followCurrentStop, initialFitRoute, isMapReady, routeCoords, stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    if (followCurrentStop) return;
    if (!hasRouteContent(stops, routeCoords, endpoints)) return;

    fitMapToRoute(map, routeCoords, stops, endpoints);
  }, [endpoints, followCurrentStop, isMapReady, routeCoords, stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    if (hasRouteContent(stops, routeCoords, endpoints)) return;
    if (!myPos) return;

    map.panTo(myPos);
  }, [endpoints, isMapReady, myPos, routeCoords, stops]);

  return (
    <div className={styles.mapShell}>
      <div ref={containerRef} className={styles.mapContainer} />
    </div>
  );
}

function resolveVisibleRouteCoords(
  stops: Stop[],
  routedCoords?: [number, number][] | null,
  routeStatus: RouteStatus = "loading"
) {
  if (routedCoords?.length) return routedCoords;
  if (routeStatus !== "failed") return [];
  return stops.map((stop) => [stop.lng, stop.lat] as [number, number]);
}

function offsetCoordinates(lat: number, lng: number, index: number, total: number) {
  if (total <= 1) return { lat, lng };
  const ring = Math.floor(index / 6);
  const posInRing = index % 6;
  const angle = (2 * Math.PI * posInRing) / 6;
  const meters = 12 + ring * 8;
  const dLat = (meters * Math.sin(angle)) / 111_320;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLng =
    (meters * Math.cos(angle)) / (111_320 * (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat));
  return { lat: lat + dLat, lng: lng + dLng };
}

function buildDisplayStops(
  stops: Stop[],
  currentIdx: number,
  spreadOverlappingStops: boolean
): DisplayStop[] {
  const coordBuckets = new Map<string, number[]>();
  for (let idx = 0; idx < stops.length; idx += 1) {
    const stop = stops[idx];
    const key = `${stop.lat.toFixed(6)},${stop.lng.toFixed(6)}`;
    const bucket = coordBuckets.get(key) ?? [];
    bucket.push(idx);
    coordBuckets.set(key, bucket);
  }

  const rankInBucket = new Map<number, { pos: number; total: number }>();
  for (const bucket of coordBuckets.values()) {
    const total = bucket.length;
    for (let pos = 0; pos < bucket.length; pos += 1) {
      rankInBucket.set(bucket[pos], { pos, total });
    }
  }

  return stops.map((stop, idx) => {
    const baseStatus: StopVisualStatus =
      idx < currentIdx ? "visited" : idx === currentIdx ? "current" : "upcoming";
    const status =
      stop.stopKind === "arrival" && idx >= currentIdx ? "arrival" : baseStatus;
    const subtitle = stop.isOverview
      ? "Starting point"
      : idx < currentIdx
        ? "Visited"
        : idx === currentIdx
          ? "At this location"
          : "Upcoming stop";
    const bucket = rankInBucket.get(idx) ?? { pos: 0, total: 1 };
    const point = spreadOverlappingStops
      ? offsetCoordinates(stop.lat, stop.lng, bucket.pos, bucket.total)
      : { lat: stop.lat, lng: stop.lng };

    return {
      id: stop.id,
      title: stop.title,
      image: stop.images?.[0] ?? "",
      subtitle,
      label: `${idx + 1}`,
      status,
      lat: point.lat,
      lng: point.lng,
    };
  });
}

function buildStopMarkerIcon(status: StopVisualStatus): google.maps.Symbol {
  const fillColor =
    status === "current"
      ? CURRENT_STOP_COLOR
      : status === "arrival"
        ? ARRIVAL_COLOR
        : status === "visited"
          ? VISITED_COLOR
          : UPCOMING_COLOR;

  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor,
    fillOpacity: 0.95,
    strokeColor: "#ffffff",
    strokeWeight: 2,
    scale: status === "current" ? 12 : 9,
  };
}

function buildEndpointMarkers(map: google.maps.Map, endpoints: Props["endpoints"]) {
  const markers: google.maps.Marker[] = [];

  if (endpoints?.origin) {
    markers.push(
      new google.maps.Marker({
        map,
        position: endpoints.origin,
        title: endpoints.origin.label || "Start",
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: ORIGIN_COLOR,
          fillOpacity: 0.95,
          strokeColor: "#ffffff",
          strokeWeight: 2,
          scale: 8,
        },
        label: {
          text: "Start",
          color: "#111111",
          fontSize: "11px",
          fontWeight: "700",
        },
        zIndex: 15,
      })
    );
  }

  if (endpoints?.destination) {
    markers.push(
      new google.maps.Marker({
        map,
        position: endpoints.destination,
        title: endpoints.destination.label || "Finish",
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: ARRIVAL_COLOR,
          fillOpacity: 0.95,
          strokeColor: "#ffffff",
          strokeWeight: 2,
          scale: 10,
        },
        label: {
          text: "Finish",
          color: "#111111",
          fontSize: "11px",
          fontWeight: "700",
        },
        zIndex: 16,
      })
    );
  }

  return markers;
}

function hasRouteContent(
  stops: Stop[],
  routeCoords: [number, number][] | null,
  endpoints?: Props["endpoints"]
) {
  return Boolean(
    stops.length ||
      routeCoords?.length ||
      endpoints?.origin ||
      endpoints?.destination
  );
}

function fitMapToRoute(
  map: google.maps.Map,
  routeCoords: [number, number][] | null,
  stops: Stop[],
  endpoints?: Props["endpoints"]
) {
  const coords: [number, number][] = routeCoords?.length
    ? [...routeCoords]
    : stops.map((stop) => [stop.lng, stop.lat]);
  if (endpoints?.origin) coords.push([endpoints.origin.lng, endpoints.origin.lat]);
  if (endpoints?.destination) {
    coords.push([endpoints.destination.lng, endpoints.destination.lat]);
  }
  if (!coords.length) return;

  if (coords.length === 1) {
    map.panTo({ lat: coords[0][1], lng: coords[0][0] });
    if ((map.getZoom() ?? 0) < 15) {
      map.setZoom(15);
    }
    return;
  }

  const bounds = new google.maps.LatLngBounds();
  for (const [lng, lat] of coords) {
    bounds.extend({ lat, lng });
  }
  map.fitBounds(bounds, 56);
}

function clearMarkers(markers: google.maps.Marker[]) {
  for (const marker of markers) {
    marker.setMap(null);
  }
}

function clearMarker(marker: google.maps.Marker | null) {
  marker?.setMap(null);
}

function clearPolyline(polyline: google.maps.Polyline | null) {
  polyline?.setMap(null);
}

function buildStopPopupContent(title: string, subtitle: string, image: string) {
  const root = document.createElement("div");
  root.className = styles.popupCard;

  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.alt = title;
    img.className = styles.popupImage;
    root.appendChild(img);
  }

  const titleEl = document.createElement("div");
  titleEl.className = styles.popupTitle;
  titleEl.textContent = title;
  root.appendChild(titleEl);

  if (subtitle) {
    const subEl = document.createElement("div");
    subEl.className = styles.popupSubtitle;
    subEl.textContent = subtitle;
    root.appendChild(subEl);
  }

  return root;
}
