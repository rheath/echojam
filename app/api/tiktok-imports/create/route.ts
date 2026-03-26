import { after, NextResponse } from "next/server";
import { normalizeTikTokUrl } from "@/lib/tiktokImport";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";
import { getTikTokImportRequestAuthorizationState } from "@/lib/server/tiktokCreatorAccess";
import { createTikTokImportJob, processQueuedTikTokImportJobs } from "@/lib/server/tiktokImportWorker";

type Body = {
  url?: string;
};

export async function POST(req: Request) {
  const access = await getTikTokImportRequestAuthorizationState(req);
  if (!access.enabled) {
    return NextResponse.json({ error: "TikTok import is unavailable." }, { status: 404 });
  }
  if (!access.authorized) {
    return NextResponse.json(
      { error: access.error || "Creator access required. Enter your code and creator email first." },
      { status: access.status || 401 }
    );
  }

  try {
    const body = (await req.json()) as Body;
    const normalized = normalizeTikTokUrl(body.url || "");
    if (!normalized) {
      return NextResponse.json(
        { error: "Enter a valid public TikTok video URL." },
        { status: 400 }
      );
    }

    const admin = getSupabaseAdminClient();
    const { data: draft, error: draftErr } = await admin
      .from("tiktok_import_drafts")
      .insert({
        source_url: normalized.normalizedUrl,
        source_kind: "video",
        source_video_id: normalized.videoId,
        status: "pending_import",
      })
      .select("id")
      .single();
    if (draftErr || !draft?.id) {
      throw new Error(draftErr?.message || "Failed to create TikTok draft");
    }

    const job = await createTikTokImportJob(draft.id as string, "import", admin);

    after(async () => {
      try {
        await processQueuedTikTokImportJobs(1, admin);
      } catch (error) {
        console.error("tiktok import worker nudge failed", error);
      }
    });

    return NextResponse.json({ draftId: draft.id, jobId: job.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create TikTok import draft" },
      { status: 500 }
    );
  }
}
