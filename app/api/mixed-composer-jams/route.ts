import { NextResponse } from "next/server";
import { ensureCreatorAccess } from "@/lib/server/creatorAccess";
import {
  listOwnedMixedComposerJourneys,
} from "@/lib/server/mixedComposerOwnership";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

export async function GET(req: Request) {
  try {
    const access = await ensureCreatorAccess(req, "mixed");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const journeys = await listOwnedMixedComposerJourneys(
      getSupabaseAdminClient(),
      access.authUser.id
    );
    return NextResponse.json({ journeys });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load creator journeys." },
      { status: 500 }
    );
  }
}
