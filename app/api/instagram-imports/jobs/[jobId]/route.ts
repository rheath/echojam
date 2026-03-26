import { NextResponse } from "next/server";
import { getInstagramImportRequestAuthorizationState } from "@/lib/server/instagramCreatorAccess";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";
import { getInstagramDraftIdsMigrationError, serializeInstagramJob } from "@/lib/server/instagramImportWorker";

export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
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
    const { jobId } = await ctx.params;
    const admin = getSupabaseAdminClient();
    const result = await admin
      .from("instagram_import_jobs")
      .select(
        "id,draft_id,draft_ids,phase,status,progress,message,error,attempts,locked_at,last_heartbeat_at,lock_token,created_at,updated_at"
      )
      .eq("id", jobId)
      .single();
    if (!result.error && result.data) {
      return NextResponse.json(serializeInstagramJob(result.data));
    }
    if (!result.error) {
      return NextResponse.json({ error: "Instagram job not found" }, { status: 404 });
    }
    if (!result.error.message.toLowerCase().includes("draft_ids")) {
      return NextResponse.json({ error: result.error.message || "Instagram job not found" }, { status: 404 });
    }

    const legacy = await admin
      .from("instagram_import_jobs")
      .select(
        "id,draft_id,phase,status,progress,message,error,attempts,locked_at,last_heartbeat_at,lock_token,created_at,updated_at"
      )
      .eq("id", jobId)
      .single();
    if (legacy.error || !legacy.data) {
      return NextResponse.json(
        { error: legacy.error?.message || getInstagramDraftIdsMigrationError() },
        { status: 404 }
      );
    }
    return NextResponse.json(serializeInstagramJob({ ...legacy.data, draft_ids: null }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Instagram import job" },
      { status: 500 }
    );
  }
}
