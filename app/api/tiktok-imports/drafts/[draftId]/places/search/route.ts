import { NextResponse } from "next/server";
import { getTikTokImportRequestAuthorizationState } from "@/lib/server/tiktokCreatorAccess";
import { searchTikTokImportPlaces } from "@/lib/server/tiktokImportWorker";

type Body = {
  query?: string | null;
};

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const access = getTikTokImportRequestAuthorizationState(req);
  if (!access.enabled) {
    return NextResponse.json({ error: "TikTok import is unavailable." }, { status: 404 });
  }
  if (!access.authorized) {
    return NextResponse.json(
      { error: "Enter a valid creator code to use the TikTok uploader." },
      { status: 401 }
    );
  }

  try {
    const { draftId } = await ctx.params;
    const body = (await req.json()) as Body;
    const candidates = await searchTikTokImportPlaces(draftId, body.query);
    return NextResponse.json({ candidates });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to search places" },
      { status: 500 }
    );
  }
}
