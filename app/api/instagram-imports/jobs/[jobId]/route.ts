import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";
import { serializeInstagramJob } from "@/lib/server/instagramImportWorker";

export async function GET(_: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await ctx.params;
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin
      .from("instagram_import_jobs")
      .select(
        "id,draft_id,phase,status,progress,message,error,attempts,locked_at,last_heartbeat_at,lock_token,created_at,updated_at"
      )
      .eq("id", jobId)
      .single();
    if (error || !data) {
      return NextResponse.json({ error: error?.message || "Instagram job not found" }, { status: 404 });
    }
    return NextResponse.json(serializeInstagramJob(data));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Instagram import job" },
      { status: 500 }
    );
  }
}
