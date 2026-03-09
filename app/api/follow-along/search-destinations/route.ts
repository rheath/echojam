import { NextResponse } from "next/server";
import { searchFollowAlongDestinations } from "@/lib/followAlongApi";

type Body = {
  query?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const results = await searchFollowAlongDestinations(body.query || "");
    return NextResponse.json({ results });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Destination search failed.";
    const status = message.includes("at least 2 characters") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
