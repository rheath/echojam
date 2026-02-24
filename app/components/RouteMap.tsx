"use client";

import { useEffect, useRef } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection, Feature, LineString, Point, GeoJsonProperties } from "geojson";
import styles from "./RouteMap.module.css";

type Stop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
};

type Props = {
  stops: Stop[];
  currentStopIndex: number;
  myPos?: { lat: number; lng: number } | null;
};

export default function RouteMap({ stops, currentStopIndex, myPos }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  // init map once
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
        // Token-free demo style (OK for MVP)
        style: "https://demotiles.maplibre.org/style.json",
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
          data: routeGeoJSON(stops),
        });

        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route",
          paint: {
             "line-color": "#2b1b3f",
             "line-width": 5,
              "line-opacity": 0.85,
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
    "case",
    ["==", ["get", "isCurrent"], true],
    "#ffb020", // current = amber
    "#2b1b3f", // others = ink
  ],
  "circle-radius": [
    "case",
    ["==", ["get", "isCurrent"], true],
    10,
    6,
  ],
  "circle-stroke-color": "#ffffff",
  "circle-stroke-width": 2,
  "circle-opacity": 0.95,
}
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
            "circle-stroke-width": 2,
            "circle-opacity": 0.9,
          },
        });

        fitMapToPoints(map, stops, myPos);
      });
    }

    init();

    return () => {
      cancelled = true;
      // If you prefer cleanup on unmount:
      // mapRef.current?.remove();
      // mapRef.current = null;
    };
  }, [stops, currentStopIndex, myPos]);

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
    routeSrc?.setData?.(routeGeoJSON(stops));

    const stopsSrc = map.getSource("stops") as GeoJSONSource | undefined;
    stopsSrc?.setData?.(stopsGeoJSON(stops, currentStopIndex));

    const meSrc = map.getSource("me") as GeoJSONSource | undefined;
    meSrc?.setData?.(myPosGeoJSON(myPos));

    const cur = stops[currentStopIndex];
    if (cur) map.easeTo({ center: [cur.lng, cur.lat], duration: 450 });
  }, [stops, currentStopIndex, myPos]);

  return (
    <div className={styles.mapShell}>
      <div ref={containerRef} className={styles.mapContainer} />
    </div>
  );
}



function routeGeoJSON(stops: Stop[]): FeatureCollection<LineString, GeoJsonProperties> {
  const feature: Feature<LineString, GeoJsonProperties> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: stops.map((s) => [s.lng, s.lat]),
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
    features: stops.map((s, idx) => ({
      type: "Feature",
      properties: { id: s.id, title: s.title, isCurrent: idx === currentIdx, idx },
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    })),
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
