import { after, NextResponse } from "next/server";
import { getInstagramImportRequestAuthorizationState } from "@/lib/server/instagramCreatorAccess";
import { createInstagramImportJob, getInstagramDraftResponseById, processQueuedInstagramImportJobs } from "@/lib/server/instagramImportWorker";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

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
    const admin = getSupabaseAdminClient();
    const draftResponse = await getInstagramDraftResponseById(draftId, admin);

    if (draftResponse.publish.publishedJamId) {
      return NextResponse.json({
        draftId,
        publishedJamId: draftResponse.publish.publishedJamId,
        publishedRouteId: draftResponse.publish.publishedRouteId,
        alreadyPublished: true,
        jobId: draftResponse.latestJob?.id ?? null,
      });
    }

    if (!draftResponse.location.publishReady) {
      return NextResponse.json(
        { error: "Confirm the location and save the title/script before publishing." },
        { status: 400 }
      );
    }

    const { data: activeJob, error: activeJobErr } = await admin
      .from("instagram_import_jobs")
      .select("id")
      .eq("draft_id", draftId)
      .eq("phase", "publish")
      .in("status", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeJobErr) throw new Error(activeJobErr.message);
    if (activeJob?.id) {
      return NextResponse.json({ draftId, jobId: activeJob.id, queued: true });
    }

    const job = await createInstagramImportJob(draftId, "publish", admin);
    after(async () => {
      try {
        await processQueuedInstagramImportJobs(1);
      } catch (error) {
        console.error("instagram publish worker nudge failed", error);
      }
    });

    return NextResponse.json({ draftId, jobId: job.id, queued: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to queue Instagram draft publish" },
      { status: 500 }
    );
  }
}
