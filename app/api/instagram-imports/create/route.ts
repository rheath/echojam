import { after, NextResponse } from "next/server";
import { normalizeInstagramUrl } from "@/lib/instagramImport";
import { createInstagramImportJob, processQueuedInstagramImportJobs } from "@/lib/server/instagramImportWorker";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type Body = {
  url?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const normalized = normalizeInstagramUrl(body.url || "");
    if (!normalized) {
      return NextResponse.json(
        { error: "Enter a public Instagram reel or post URL." },
        { status: 400 }
      );
    }

    const admin = getSupabaseAdminClient();
    const { data: draft, error: draftErr } = await admin
      .from("instagram_import_drafts")
      .insert({
        source_url: normalized.normalizedUrl,
        source_kind: normalized.sourceKind,
        source_shortcode: normalized.shortcode,
        status: "pending_import",
      })
      .select("id")
      .single();
    if (draftErr || !draft?.id) {
      throw new Error(draftErr?.message || "Failed to create Instagram draft");
    }

    const job = await createInstagramImportJob(draft.id as string, "import", admin);

    after(async () => {
      try {
        await processQueuedInstagramImportJobs(1);
      } catch (error) {
        console.error("instagram import worker nudge failed", error);
      }
    });

    return NextResponse.json({ draftId: draft.id, jobId: job.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create Instagram import draft" },
      { status: 500 }
    );
  }
}
