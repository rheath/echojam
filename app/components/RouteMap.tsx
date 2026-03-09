"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection, Feature, LineString, Point, GeoJsonProperties } from "geojson";
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
  const mapRef = useRef<MapLibreMap | null>(null);
  const initialViewRef = useRef<{ lat: number; lng: number; zoom: number } | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(
    providedRouteCoords
  );
  const [routeStatus, setRouteStatus] = useState<"loading" | "ready" | "failed">("loading");

  if (!initialViewRef.current) {
    const first =
      stops[0] ??
      endpoints?.origin ??
      myPos ??
      cityCenter ??
      { lat: 42.5195, lng: -70.8967 };
    initialViewRef.current = {
      lat: first.lat,
      lng: first.lng,
      zoom: stops.length ? 15 : 13,
    };
  }

  useEffect(() => {
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
    let cancelled = false;
    const controller = new AbortController();

    async function loadWalkingRoute() {
      setRouteStatus("loading");
      if (stops.length < 2) {
        setRouteCoords(null);
        setRouteStatus("failed");
        return;
      }

      const coordinates = stops.map((s) => `${s.lng},${s.lat}`).join(";");
      const url = `https://router.project-osrm.org/route/v1/foot/${coordinates}?overview=full&geometries=geojson&steps=false`;

      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("Route request failed");
        const data = (await res.json()) as {
          routes?: Array<{ geometry?: { coordinates?: [number, number][] } }>;
        };
        const coords = data.routes?.[0]?.geometry?.coordinates;
        if (cancelled) return;
        if (coords && coords.length) {
          setRouteCoords(coords);
          setRouteStatus("ready");
        } else {
          setRouteCoords(null);
          setRouteStatus("failed");
        }
      } catch {
        if (!cancelled) {
          setRouteCoords(null);
          setRouteStatus("failed");
        }
      }
    }

    void loadWalkingRoute();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [providedRouteCoords, routeTravelMode, showRoutePath, stops]);

  // init map
  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!containerRef.current) return;
      if (mapRef.current) return;

      const maplibregl = await import("maplibre-gl");
      if (cancelled) return;
      const initialView = initialViewRef.current ?? { lat: 42.5195, lng: -70.8967, zoom: 13 };

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
        center: [initialView.lng, initialView.lat],
        zoom: initialView.zoom,
        attributionControl: { compact: true },
      });

      mapRef.current = map;

      map.on("load", () => {
        if (cancelled) return;

        map.resize();

        map.addSource("route", {
          type: "geojson",
          data: routeGeoJSON([], null, "loading"),
        });

        map.addLayer({
          id: "route-line-underlay",
          type: "line",
          source: "route",
          paint: {
            "line-color": "#ffffff",
            "line-width": 8,
            "line-opacity": 0.8,
          },
        });

        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route",
          paint: {
            "line-color": "#2b1b3f",
            "line-width": 5,
            "line-opacity": 0.9,
          },
        });

        map.addSource("stops", {
          type: "geojson",
          data: stopsGeoJSON([], 0, false),
        });

        map.addLayer({
          id: "stops-circle",
          type: "circle",
          source: "stops",
          paint: {
            "circle-color": [
              "match",
              ["get", "status"],
              "current",
              "#ff5f92",
              "arrival",
              "#2e78ff",
              "visited",
              "#8e93a3",
              "#2b1b3f",
            ],
            "circle-radius": [
              "match",
              ["get", "status"],
              "current",
              12,
              9,
            ],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
            "circle-opacity": 0.95,
          },
        });

        map.addLayer({
          id: "stops-label",
          type: "symbol",
          source: "stops",
          layout: {
            "text-field": ["get", "label"],
            "text-size": 12,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          },
          paint: {
            "text-color": [
              "match",
              ["get", "status"],
              "current",
              "#111111",
              "#ffffff",
            ],
          },
        });

        map.addSource("me", {
          type: "geojson",
          data: myPosGeoJSON(null),
        });

        map.addLayer({
          id: "me-circle",
          type: "circle",
          source: "me",
          paint: {
            "circle-radius": 6,
            "circle-color": "#2e78ff",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
            "circle-opacity": 0.9,
          },
        });

        map.addSource("endpoints", {
          type: "geojson",
          data: endpointGeoJSON(null),
        });

        map.addLayer({
          id: "endpoint-circle",
          type: "circle",
          source: "endpoints",
          paint: {
            "circle-radius": [
              "match",
              ["get", "kind"],
              "origin",
              8,
              10,
            ],
            "circle-color": [
              "match",
              ["get", "kind"],
              "origin",
              "#111111",
              "#2e78ff",
            ],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
            "circle-opacity": 0.95,
          },
        });

        map.addLayer({
          id: "endpoint-label",
          type: "symbol",
          source: "endpoints",
          layout: {
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-offset": [0, 1.4],
          },
          paint: {
            "text-color": "#111111",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.5,
          },
        });

        map.on("mouseenter", "stops-circle", () => {
          map.getCanvas().style.cursor = "pointer";
        });

        map.on("mouseleave", "stops-circle", () => {
          map.getCanvas().style.cursor = "";
        });

        map.on("click", "stops-circle", (e) => {
          const feature = e.features?.[0];
          if (!feature || feature.geometry.type !== "Point") return;

          const props = feature.properties ?? {};
          const title = typeof props.title === "string" ? props.title : "Stop";
          const subtitle = typeof props.subtitle === "string" ? props.subtitle : "";
          const image = typeof props.image === "string" ? props.image : "";
          const coordinates = feature.geometry.coordinates as [number, number];

          new maplibregl.Popup({ closeButton: false, offset: 14 })
            .setLngLat(coordinates)
            .setDOMContent(buildStopPopupContent(title, subtitle, image))
            .addTo(map);
        });

        setIsMapReady(true);
      });
    }

    init();

    return () => {
      cancelled = true;
      setIsMapReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onResize = () => mapRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // update sources when data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!isMapReady || !map.isStyleLoaded()) return;

    const routeSrc = map.getSource("route") as GeoJSONSource | undefined;
    routeSrc?.setData?.(
      routeGeoJSON(
        stops,
        showRoutePath ? routeCoords : null,
        showRoutePath ? routeStatus : "loading"
      )
    );

    const stopsSrc = map.getSource("stops") as GeoJSONSource | undefined;
    stopsSrc?.setData?.(stopsGeoJSON(stops, currentStopIndex, spreadOverlappingStops));

    const meSrc = map.getSource("me") as GeoJSONSource | undefined;
    meSrc?.setData?.(myPosGeoJSON(myPos));

    const endpointSrc = map.getSource("endpoints") as GeoJSONSource | undefined;
    endpointSrc?.setData?.(endpointGeoJSON(endpoints));
  }, [currentStopIndex, endpoints, isMapReady, myPos, routeCoords, routeStatus, showRoutePath, spreadOverlappingStops, stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!isMapReady || !map.isStyleLoaded()) return;

    if (initialFitRoute && currentStopIndex <= 0) {
      fitMapToRoute(map, routeCoords, stops, endpoints);
      return;
    }

    if (!followCurrentStop) return;
    const cur = stops[currentStopIndex];
    if (cur) map.easeTo({ center: [cur.lng, cur.lat], duration: 450 });
  }, [currentStopIndex, endpoints, followCurrentStop, initialFitRoute, isMapReady, routeCoords, stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!isMapReady || !map.isStyleLoaded()) return;
    if (followCurrentStop) return;
    if (!stops.length) return;

    fitMapToRoute(map, routeCoords, stops, endpoints);
  }, [endpoints, followCurrentStop, isMapReady, routeCoords, stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!isMapReady || !map.isStyleLoaded()) return;
    if (stops.length > 0) return;
    if (!myPos) return;

    map.easeTo({ center: [myPos.lng, myPos.lat], duration: 350 });
  }, [isMapReady, myPos, stops]);

  return (
    <div className={styles.mapShell}>
      <div ref={containerRef} className={styles.mapContainer} />
    </div>
  );
}



function routeGeoJSON(
  stops: Stop[],
  routedCoords?: [number, number][] | null,
  routeStatus: "loading" | "ready" | "failed" = "loading"
): FeatureCollection<LineString, GeoJsonProperties> {
  if (routedCoords?.length) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: routedCoords },
        },
      ],
    };
  }

  // Avoid drawing a temporary straight line while walking geometry is loading.
  if (routeStatus !== "failed") {
    return { type: "FeatureCollection", features: [] };
  }

  const feature: Feature<LineString, GeoJsonProperties> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: routedCoords?.length ? routedCoords : stops.map((s) => [s.lng, s.lat]),
    },
  };

  return {
    type: "FeatureCollection",
    features: [feature],
  };
}

function offsetCoordinates(lat: number, lng: number, index: number, total: number) {
  if (total <= 1) return { lat, lng };
  const ring = Math.floor(index / 6);
  const posInRing = index % 6;
  const angle = (2 * Math.PI * posInRing) / 6;
  const meters = 12 + ring * 8;
  const dLat = (meters * Math.sin(angle)) / 111_320;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLng = (meters * Math.cos(angle)) / (111_320 * (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat));
  return { lat: lat + dLat, lng: lng + dLng };
}

function stopsGeoJSON(
  stops: Stop[],
  currentIdx: number,
  spreadOverlappingStops: boolean
): FeatureCollection<Point, GeoJsonProperties> {
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

  return {
    type: "FeatureCollection",
    features: stops.map((s, idx) => {
      const status = idx < currentIdx ? "visited" : idx === currentIdx ? "current" : "upcoming";
      const visualStatus =
        s.stopKind === "arrival" && idx >= currentIdx ? "arrival" : status;
      const isOverview = Boolean(s.isOverview);
      const subtitle = isOverview
        ? "Starting point"
        : idx < currentIdx
          ? "Visited"
          : idx === currentIdx
            ? "At this location"
            : "Upcoming stop";
      const bucket = rankInBucket.get(idx) ?? { pos: 0, total: 1 };
      const point = spreadOverlappingStops ? offsetCoordinates(s.lat, s.lng, bucket.pos, bucket.total) : { lat: s.lat, lng: s.lng };
      return {
        type: "Feature",
        properties: {
          id: s.id,
          title: s.title,
          isOverview,
          isCurrent: idx === currentIdx,
          idx,
          label: `${idx + 1}`,
          status: visualStatus,
          subtitle,
          image: s.images?.[0] ?? "",
        },
        geometry: { type: "Point", coordinates: [point.lng, point.lat] },
      };
    }),
  };
}

function endpointGeoJSON(
  endpoints: Props["endpoints"]
): FeatureCollection<Point, GeoJsonProperties> {
  const features: Array<Feature<Point, GeoJsonProperties>> = [];
  if (endpoints?.origin) {
    features.push({
      type: "Feature",
      properties: {
        label: "Start",
        kind: "origin",
      },
      geometry: {
        type: "Point",
        coordinates: [endpoints.origin.lng, endpoints.origin.lat],
      },
    });
  }
  if (endpoints?.destination) {
    features.push({
      type: "Feature",
      properties: {
        label: "Finish",
        kind: "destination",
      },
      geometry: {
        type: "Point",
        coordinates: [endpoints.destination.lng, endpoints.destination.lat],
      },
    });
  }
  return {
    type: "FeatureCollection",
    features,
  };
}

function myPosGeoJSON(
  myPos: { lat: number; lng: number } | null | undefined
): FeatureCollection<Point, GeoJsonProperties> {
  if (!myPos) {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [myPos.lng, myPos.lat] },
      },
    ],
  };
}

function fitMapToRoute(
  map: MapLibreMap,
  routeCoords: [number, number][] | null,
  stops: Stop[],
  endpoints?: Props["endpoints"]
) {
  const coords: [number, number][] = routeCoords?.length ? [...routeCoords] : stops.map((s) => [s.lng, s.lat]);
  if (endpoints?.origin) coords.push([endpoints.origin.lng, endpoints.origin.lat]);
  if (endpoints?.destination) coords.push([endpoints.destination.lng, endpoints.destination.lat]);
  if (!coords.length) return;

  let minX = coords[0][0];
  let minY = coords[0][1];
  let maxX = coords[0][0];
  let maxY = coords[0][1];

  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  map.fitBounds(
    [
      [minX, minY],
      [maxX, maxY],
    ],
    { padding: 56, duration: 350 }
  );
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
