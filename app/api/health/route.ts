import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "echojam",
    ts: new Date().toISOString(),
  });
}
