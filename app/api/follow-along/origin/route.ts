import { NextResponse } from "next/server";
import { reverseGeocodeFollowAlongOrigin } from "@/lib/followAlongApi";

type Body = {
  lat?: number;
  lng?: number;
};

function isFiniteCoord(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 180;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const lat = Number(body.lat);
    const lng = Number(body.lng);

    if (!isFiniteCoord(lat) || !isFiniteCoord(lng) || Math.abs(lat) > 90) {
      return NextResponse.json(
        { error: "Valid origin coordinates are required." },
        { status: 400 }
      );
    }

    const origin = await reverseGeocodeFollowAlongOrigin({ lat, lng });
    return NextResponse.json({ origin });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Origin lookup failed." },
      { status: 500 }
    );
  }
}
