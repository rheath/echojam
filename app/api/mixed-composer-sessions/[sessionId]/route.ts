import { NextResponse } from "next/server";
import {
  serializeMixedComposerSession,
  toMixedComposerSessionPatch,
  type MixedComposerSessionSnapshot,
} from "@/lib/mixedComposerSession";
import { ensureCreatorAccess } from "@/lib/server/creatorAccess";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

const SESSION_SELECT = `
  id,
  jam_id,
  base_route_id,
  draft_status,
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

export async function GET(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const access = await ensureCreatorAccess(_req, "mixed");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const { sessionId } = await ctx.params;
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin
      .from("mixed_composer_sessions")
      .select(SESSION_SELECT)
      .eq("id", sessionId)
      .eq("owner_user_id", access.authUser.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      return NextResponse.json({ error: "Mixed composer session not found" }, { status: 404 });
    }

    return NextResponse.json(serializeMixedComposerSession(data));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load mixed composer session" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const access = await ensureCreatorAccess(req, "mixed");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const { sessionId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Partial<MixedComposerSessionSnapshot>;
    const patch = toMixedComposerSessionPatch(body);
    const admin = getSupabaseAdminClient();

    if (Object.keys(patch).length > 0) {
      const { error } = await admin
        .from("mixed_composer_sessions")
        .update(patch)
        .eq("id", sessionId)
        .eq("owner_user_id", access.authUser.id);
      if (error) throw new Error(error.message);
    }

    const { data, error } = await admin
      .from("mixed_composer_sessions")
      .select(SESSION_SELECT)
      .eq("id", sessionId)
      .eq("owner_user_id", access.authUser.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return NextResponse.json({ error: "Mixed composer session not found" }, { status: 404 });
    }

    return NextResponse.json(serializeMixedComposerSession(data));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update mixed composer session" },
      { status: 500 }
    );
  }
}
