import { NextResponse } from "next/server";
import { fetchDirectionsRoutePath, type DirectionsRouteMode } from "@/lib/followAlongApi";

type LatLng = {
  lat: number;
  lng: number;
};

type Body = {
  origin?: LatLng;
  destination?: LatLng;
  intermediates?: LatLng[];
  mode?: DirectionsRouteMode;
};

function isValidLatLng(value: unknown): value is LatLng {
  if (!value || typeof value !== "object") return false;
  const candidate = value as LatLng;
  return (
    Number.isFinite(candidate.lat) &&
    Number.isFinite(candidate.lng) &&
    Math.abs(candidate.lat) <= 90 &&
    Math.abs(candidate.lng) <= 180
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!isValidLatLng(body.origin) || !isValidLatLng(body.destination)) {
      return NextResponse.json(
        { error: "Valid origin and destination are required." },
        { status: 400 }
      );
    }

    const coords = await fetchDirectionsRoutePath({
      origin: body.origin,
      destination: body.destination,
      intermediates: Array.isArray(body.intermediates)
        ? body.intermediates.filter(isValidLatLng)
        : [],
      mode: body.mode === "walk" ? "walk" : "drive",
    });

    return NextResponse.json({ routeCoords: coords });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Route preview failed." },
      { status: 500 }
    );
  }
}
