"use client";

import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap } from "react-leaflet";
import L from "leaflet";

type LatLng = { lat: number; lng: number };

type Stop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
};

type Props = {
  stops: Stop[];
  currentStopIndex: number;
  myPos?: LatLng | null;
};

function FitBounds({ stops, myPos }: { stops: Stop[]; myPos?: LatLng | null }) {
  const map = useMap();

  // Fit bounds on mount and whenever stop list changes
  const points: L.LatLngExpression[] = stops.map((s) => [s.lat, s.lng]);
  if (myPos) points.push([myPos.lat, myPos.lng]);

  if (points.length >= 1) {
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds.pad(0.2));
  }

  return null;
}

// Fix default marker icons in Next builds (Leaflet expects images in a specific path)
const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

export default function RouteMap({ stops, currentStopIndex, myPos }: Props) {
  const center: LatLng = stops.length ? { lat: stops[0].lat, lng: stops[0].lng } : { lat: 42.5195, lng: -70.8967 };

  const line = stops.map((s) => [s.lat, s.lng] as [number, number]);

  return (
    <div style={{ height: 220, width: "100%", borderRadius: 12, overflow: "hidden", border: "1px solid #ddd" }}>
      <MapContainer center={[center.lat, center.lng]} zoom={15} style={{ height: "100%", width: "100%" }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <FitBounds stops={stops} myPos={myPos} />

        {/* Route line */}
        {line.length >= 2 && <Polyline positions={line} />}

        {/* Stops */}
        {stops.map((s, idx) => {
          const isCurrent = idx === currentStopIndex;
          return (
            <Marker key={s.id} position={[s.lat, s.lng]} icon={DefaultIcon}>
              <Popup>
                <div style={{ fontWeight: 700 }}>{isCurrent ? "Current stop" : `Stop ${idx + 1}`}</div>
                <div>{s.title}</div>
              </Popup>
            </Marker>
          );
        })}

        {/* Highlight current stop */}
        {stops[currentStopIndex] && (
          <CircleMarker
            center={[stops[currentStopIndex].lat, stops[currentStopIndex].lng]}
            radius={10}
            pathOptions={{ weight: 2 }}
          />
        )}

        {/* Your location */}
        {myPos && <CircleMarker center={[myPos.lat, myPos.lng]} radius={6} pathOptions={{ weight: 2 }} />}
      </MapContainer>
    </div>
  );
}