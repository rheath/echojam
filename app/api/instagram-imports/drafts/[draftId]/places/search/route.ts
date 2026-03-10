import { NextResponse } from "next/server";
import { searchInstagramImportPlaces } from "@/lib/server/instagramImportWorker";

type Body = {
  query?: string | null;
};

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const { draftId } = await ctx.params;
    const body = (await req.json()) as Body;
    const candidates = await searchInstagramImportPlaces(draftId, body.query);
    return NextResponse.json({ candidates });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to search places" },
      { status: 500 }
    );
  }
}
