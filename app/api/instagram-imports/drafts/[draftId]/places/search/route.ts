import { NextResponse } from "next/server";
import { getInstagramImportRequestAuthorizationState } from "@/lib/server/instagramCreatorAccess";
import { searchInstagramImportPlaces } from "@/lib/server/instagramImportWorker";

type Body = {
  query?: string | null;
};

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const access = await getInstagramImportRequestAuthorizationState(req);
  if (!access.enabled) {
    return NextResponse.json({ error: "Instagram import is unavailable." }, { status: 404 });
  }
  if (!access.authorized) {
    return NextResponse.json(
      { error: access.error || "Creator access required. Enter your code and creator email first." },
      { status: access.status || 401 }
    );
  }

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
