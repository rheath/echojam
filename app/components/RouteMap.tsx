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
  images?: string[];
};

type Props = {
  stops: Stop[];
  currentStopIndex: number;
  myPos?: { lat: number; lng: number } | null;
};

export default function RouteMap({ stops, currentStopIndex, myPos }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadWalkingRoute() {
      if (stops.length < 2) {
        setRouteCoords(null);
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
        setRouteCoords(coords && coords.length ? coords : null);
      } catch {
        if (!cancelled) setRouteCoords(null);
      }
    }

    void loadWalkingRoute();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [stops]);

  // init map
  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!containerRef.current) return;
      if (mapRef.current) return;
      if (!stops.length) return;

      const maplibregl = await import("maplibre-gl");
      if (cancelled) return;

      const first = stops[0];

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
        center: [first.lng, first.lat],
        zoom: 15,
        attributionControl: { compact: true },
      });

      mapRef.current = map;
      map.on("load", () => map.resize());

      map.on("load", () => {
        if (cancelled) return;

        // Route line
        map.addSource("route", {
          type: "geojson",
          data: routeGeoJSON(stops, routeCoords),
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

        // Stops
        map.addSource("stops", {
          type: "geojson",
          data: stopsGeoJSON(stops, currentStopIndex),
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
              "visited",
              "#8e93a3",
              "#2b1b3f",
            ],
            "circle-radius": [
              "match",
              ["get", "status"],
              "current",
              10,
              7,
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
            "text-size": 11,
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

        // My position
        map.addSource("me", {
          type: "geojson",
          data: myPosGeoJSON(myPos),
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

        fitMapToPoints(map, stops, myPos);
      });
    }

    init();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [stops, currentStopIndex, myPos, routeCoords]);

  useEffect(() => {
    const onResize = () => mapRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // update sources when data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map.isStyleLoaded()) return;

    const routeSrc = map.getSource("route") as GeoJSONSource | undefined;
    routeSrc?.setData?.(routeGeoJSON(stops, routeCoords));

    const stopsSrc = map.getSource("stops") as GeoJSONSource | undefined;
    stopsSrc?.setData?.(stopsGeoJSON(stops, currentStopIndex));

    const meSrc = map.getSource("me") as GeoJSONSource | undefined;
    meSrc?.setData?.(myPosGeoJSON(myPos));

    const cur = stops[currentStopIndex];
    if (cur) map.easeTo({ center: [cur.lng, cur.lat], duration: 450 });
  }, [stops, currentStopIndex, myPos, routeCoords]);

  return (
    <div className={styles.mapShell}>
      <div ref={containerRef} className={styles.mapContainer} />
    </div>
  );
}



function routeGeoJSON(
  stops: Stop[],
  routedCoords?: [number, number][] | null
): FeatureCollection<LineString, GeoJsonProperties> {
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

function stopsGeoJSON(stops: Stop[], currentIdx: number): FeatureCollection<Point, GeoJsonProperties> {
  return {
    type: "FeatureCollection",
    features: stops.map((s, idx) => {
      const status = idx < currentIdx ? "visited" : idx === currentIdx ? "current" : "upcoming";
      const subtitle = idx < currentIdx ? "Visited" : idx === currentIdx ? "At this location" : "Upcoming stop";
      return {
        type: "Feature",
        properties: {
          id: s.id,
          title: s.title,
          isCurrent: idx === currentIdx,
          idx,
          label: `${idx + 1}`,
          status,
          subtitle,
          image: s.images?.[0] ?? "",
        },
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      };
    }),
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

function fitMapToPoints(map: MapLibreMap, stops: Stop[], myPos?: { lat: number; lng: number } | null) {
  const coords: [number, number][] = stops.map((s) => [s.lng, s.lat]);
  if (myPos) coords.push([myPos.lng, myPos.lat]);
  if (!coords.length) return;

  let minX = coords[0][0],
    minY = coords[0][1],
    maxX = coords[0][0],
    maxY = coords[0][1];

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
    { padding: 40, duration: 0 }
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
