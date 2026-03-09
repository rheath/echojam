import { NextResponse } from "next/server";

function isEnabled(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
}

export async function GET() {
  const nearbyStoryEnabled =
    isEnabled(process.env.ENABLE_NEARBY_STORY) ||
    isEnabled(process.env.NEXT_PUBLIC_ENABLE_NEARBY_STORY);

  return NextResponse.json(
    { nearbyStoryEnabled },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
