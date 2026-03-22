import { NextResponse } from "next/server";
import {
  serializeMixedComposerSession,
  toMixedComposerSessionInsert,
  type MixedComposerSessionSnapshot,
} from "@/lib/mixedComposerSession";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

const SESSION_SELECT = `
  id,
  active_provider,
  route_title,
  custom_narrator_guidance,
  stops,
  instagram_draft_id,
  instagram_draft_ids,
  tiktok_draft_id,
  active_import_job,
  google_place_draft,
  created_at,
  updated_at
`;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<MixedComposerSessionSnapshot>;
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin
      .from("mixed_composer_sessions")
      .insert(toMixedComposerSessionInsert(body))
      .select(SESSION_SELECT)
      .single();

    if (error || !data) {
      throw new Error(error?.message || "Failed to create mixed composer session");
    }

    return NextResponse.json(serializeMixedComposerSession(data));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create mixed composer session" },
      { status: 500 }
    );
  }
}
