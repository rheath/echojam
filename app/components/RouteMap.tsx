"use client";

import { useEffect, useRef, useState } from "react";
import {
  getGoogleMapsMapId,
  loadGoogleMapsLibraries,
} from "@/lib/googleMapsLoader";
import {
  buildRouteLookupPlan,
  resolveVisibleRouteCoords,
  type RouteStatus,
} from "@/lib/routePath";
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
  interactive?: boolean;
};

type StopVisualStatus = "visited" | "current" | "upcoming" | "arrival";
type RouteMarker = google.maps.marker.AdvancedMarkerElement;
type MarkerVisual = {
  background: string;
  borderColor: string;
  glyph?: string;
  glyphColor?: string;
  scale?: number;
};
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
const DEFAULT_CENTER = { lat: 42.5195, lng: -70.8967 };
const ROUTE_LINE_COLOR = "#2b1b3f";
const ROUTE_LINE_UNDERLAY = "#ffffff";
const CURRENT_STOP_COLOR = "#ff5f92";
const ARRIVAL_COLOR = "#2e78ff";
const VISITED_COLOR = "#8e93a3";
const UPCOMING_COLOR = "#2b1b3f";
const USER_COLOR = "#2e78ff";
const ORIGIN_COLOR = "#111111";
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
  interactive = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const stopMarkersRef = useRef<RouteMarker[]>([]);
  const endpointMarkersRef = useRef<RouteMarker[]>([]);
  const meMarkerRef = useRef<RouteMarker | null>(null);
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

    async function loadRoutePath() {
      const plan = buildRouteLookupPlan({
        providedRouteCoords,
        showRoutePath,
        routeTravelMode,
        stops,
        endpoints,
      });

      if (plan.kind === "provided") {
        setRouteCoords(plan.coords);
        setRouteStatus("ready");
        return;
      }

      if (plan.kind === "fallback") {
        setRouteCoords(null);
        setRouteStatus("failed");
        return;
      }

      setRouteStatus("loading");

      try {
        const response = await fetch("/api/route-path", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            origin: plan.request.origin,
            destination: plan.request.destination,
            intermediates: plan.request.intermediates?.map((waypoint) => waypoint.location) ?? [],
            mode: routeTravelMode,
          }),
        });
        if (cancelled) return;
        if (!response.ok) {
          throw new Error(`Route path request failed with status ${response.status}`);
        }
        const payload = (await response.json()) as {
          routeCoords?: [number, number][];
        };
        const coords = Array.isArray(payload.routeCoords) ? payload.routeCoords : [];

        if (coords.length > 1) {
          setRouteCoords(coords);
          setRouteStatus("ready");
          return;
        }
      } catch (error) {
        console.error("Route path lookup failed.", error);
      }

      if (!cancelled) {
        setRouteCoords(null);
        setRouteStatus("failed");
      }
    }

    void loadRoutePath();

    return () => {
      cancelled = true;
    };
  }, [endpoints, providedRouteCoords, routeTravelMode, showRoutePath, stops]);

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
          mapId: getGoogleMapsMapId(),
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          keyboardShortcuts: true,
          gestureHandling: "greedy",
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

    map.setOptions({
      clickableIcons: false,
      keyboardShortcuts: interactive,
      gestureHandling: interactive ? "greedy" : "none",
    });
  }, [interactive, isMapReady]);

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
      const marker = createPinMarker({
        map,
        position: { lat: stop.lat, lng: stop.lng },
        title: stop.title,
        visual: buildStopMarkerIcon(stop.status, stop.label),
        zIndex: stop.status === "current" ? 30 : 20 + idx,
        clickable: interactive,
      });

      if (interactive) {
        marker.addListener("click", () => {
          const infoWindow = infoWindowRef.current;
          if (!infoWindow) return;
          infoWindow.setContent(buildStopPopupContent(stop.title, stop.subtitle, stop.image));
          infoWindow.open({ map, anchor: marker });
        });
      }

      return marker;
    });

    clearMarkers(endpointMarkersRef.current);
    endpointMarkersRef.current = buildEndpointMarkers(map, endpoints);

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
    routeCoords,
    routeStatus,
    showRoutePath,
    spreadOverlappingStops,
    stops,
    interactive,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (!myPos) {
      clearMarker(meMarkerRef.current);
      meMarkerRef.current = null;
      return;
    }

    if (meMarkerRef.current) {
      meMarkerRef.current.position = myPos;
      return;
    }

    meMarkerRef.current = createPinMarker({
      map,
      position: myPos,
      title: "Your location",
      visual: {
        background: USER_COLOR,
        borderColor: "#ffffff",
        scale: 0.72,
      },
      zIndex: 10,
    });
  }, [isMapReady, myPos]);

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
      <div
        ref={containerRef}
        className={`${styles.mapContainer} ${!interactive ? styles.mapContainerStatic : ""}`}
      />
    </div>
  );
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

function buildStopMarkerIcon(status: StopVisualStatus, label: string) {
  const background =
    status === "current"
      ? CURRENT_STOP_COLOR
      : status === "arrival"
        ? ARRIVAL_COLOR
        : status === "visited"
          ? VISITED_COLOR
          : UPCOMING_COLOR;

  return {
    background,
    borderColor: "#ffffff",
    glyphColor: status === "current" ? "#111111" : "#ffffff",
    glyph: label,
    scale: status === "current" ? 1.15 : 0.96,
  } satisfies MarkerVisual;
}

function buildEndpointMarkers(map: google.maps.Map, endpoints: Props["endpoints"]) {
  const markers: RouteMarker[] = [];

  if (endpoints?.origin) {
    markers.push(
      createPinMarker({
        map,
        position: endpoints.origin,
        title: endpoints.origin.label || "Start",
        visual: {
          background: ORIGIN_COLOR,
          borderColor: "#ffffff",
          glyphColor: "#ffffff",
          glyph: "S",
          scale: 0.9,
        },
        zIndex: 15,
      })
    );
  }

  if (endpoints?.destination) {
    markers.push(
      createPinMarker({
        map,
        position: endpoints.destination,
        title: endpoints.destination.label || "Finish",
        visual: {
          background: ARRIVAL_COLOR,
          borderColor: "#ffffff",
          glyphColor: "#ffffff",
          glyph: "F",
          scale: 1,
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

function clearMarkers(markers: RouteMarker[]) {
  for (const marker of markers) {
    marker.map = null;
  }
}

function clearMarker(marker: RouteMarker | null) {
  if (marker) {
    marker.map = null;
  }
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

function createPinMarker(params: {
  map: google.maps.Map;
  position: google.maps.LatLngLiteral;
  title: string;
  visual: MarkerVisual;
  zIndex?: number;
  clickable?: boolean;
}) {
  const marker = new google.maps.marker.AdvancedMarkerElement({
    map: params.map,
    position: params.position,
    title: params.title,
    zIndex: params.zIndex,
    content: buildPinMarkerContent(params.visual, Boolean(params.clickable)),
  });
  return marker;
}

function buildPinMarkerContent(params: MarkerVisual, clickable: boolean) {
  const scale = params.scale ?? 1;
  const diameter = Math.round(36 * scale);
  const glyph = params.glyph ?? "";
  const glyphColor = params.glyphColor ?? "#ffffff";
  const glyphFontSize = Math.round((glyph.length > 1 ? 14 : 18) * Math.max(scale, 0.9));

  const root = document.createElement("div");
  root.style.width = `${diameter}px`;
  root.style.height = `${diameter}px`;
  root.style.display = "flex";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.boxSizing = "border-box";
  root.style.border = `2.5px solid ${params.borderColor}`;
  root.style.borderRadius = "999px";
  root.style.background = params.background;
  root.style.boxShadow = "0 2px 10px rgba(17, 17, 17, 0.18)";
  root.style.color = glyphColor;
  root.style.fontFamily = "Arial, sans-serif";
  root.style.fontSize = `${glyphFontSize}px`;
  root.style.fontWeight = "700";
  root.style.lineHeight = "1";
  root.style.userSelect = "none";
  root.style.cursor = clickable ? "pointer" : "default";
  root.style.transform = "translateY(50%)";

  if (glyph) {
    root.textContent = glyph;
  } else {
    root.setAttribute("aria-hidden", "true");
  }

  return root;
}
