import { NextResponse } from "next/server";
import { getTikTokImportRequestAuthorizationState } from "@/lib/server/tiktokCreatorAccess";
import { getTikTokJobResponseById } from "@/lib/server/tiktokImportWorker";

export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
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
    const { jobId } = await ctx.params;
    const job = await getTikTokJobResponseById(jobId);
    if (!job) {
      return NextResponse.json({ error: "TikTok job not found" }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load TikTok import job" },
      { status: 500 }
    );
  }
}
