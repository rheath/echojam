import { NextResponse } from "next/server";
import { ensureCreatorAccess } from "@/lib/server/creatorAccess";
import {
  createMixedComposerSessionFromRoute,
  extractCustomRouteId,
  findLatestOwnedMixedSessionForJam,
  loadOwnedJamForMixedResume,
} from "@/lib/server/mixedComposerOwnership";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

export async function POST(req: Request, ctx: { params: Promise<{ jamId: string }> }) {
  try {
    const access = await ensureCreatorAccess(req, "mixed");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const { jamId } = await ctx.params;
    const admin = getSupabaseAdminClient();
    const existingSession = await findLatestOwnedMixedSessionForJam(admin, jamId, access.authUser.id);
    if (existingSession?.id) {
      return NextResponse.json({ sessionId: existingSession.id, reused: true });
    }

    const jam = await loadOwnedJamForMixedResume(admin, jamId, access.authUser.id);
    if (!jam) {
      return NextResponse.json({ error: "That journey is not available for editing." }, { status: 404 });
    }

    const routeId = extractCustomRouteId(jam.route_id);
    if (!routeId) {
      return NextResponse.json(
        { error: "Only creator-owned custom journeys can be reopened here." },
        { status: 400 }
      );
    }

    const sessionId = await createMixedComposerSessionFromRoute({
      admin,
      ownerUserId: access.authUser.id,
      jamId,
      routeId,
    });
    return NextResponse.json({ sessionId, reused: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reopen the journey." },
      { status: 500 }
    );
  }
}
