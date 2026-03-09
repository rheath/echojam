import { NextResponse } from "next/server";
import {
  fetchDrivingRoutePreview,
  isValidFollowAlongLocation,
} from "@/lib/followAlongApi";
import type { FollowAlongLocation } from "@/lib/followAlong";

type Body = {
  origin?: FollowAlongLocation;
  destination?: FollowAlongLocation;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (
      !isValidFollowAlongLocation(body.origin) ||
      !isValidFollowAlongLocation(body.destination)
    ) {
      return NextResponse.json(
        { error: "Valid origin and destination are required." },
        { status: 400 }
      );
    }

    const preview = await fetchDrivingRoutePreview(body.origin, body.destination);
    return NextResponse.json(preview);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Route preview failed." },
      { status: 500 }
    );
  }
}
