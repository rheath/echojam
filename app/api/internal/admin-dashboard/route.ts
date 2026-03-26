import { NextResponse } from "next/server";
import {
  createCreatorCodeInvite,
  listRecentCreatorCodeInvites,
} from "@/lib/server/creatorCodeDashboard";
import { ensureCreatorCodeDashboardAdminAccess } from "@/lib/server/internalAdminAccess";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type Body = {
  email?: string | null;
  code?: string | null;
};

export async function GET(req: Request) {
  try {
    const access = await ensureCreatorCodeDashboardAdminAccess(req);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const invites = await listRecentCreatorCodeInvites(getSupabaseAdminClient());
    return NextResponse.json({
      ok: true,
      email: access.normalizedEmail,
      invites,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load creator invites." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = await ensureCreatorCodeDashboardAdminAccess(req);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const invite = await createCreatorCodeInvite(getSupabaseAdminClient(), {
      email: body.email,
      code: body.code,
    });
    return NextResponse.json({
      ok: true,
      inviteId: invite.id,
      email: invite.email,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create creator invite.";
    const status =
      message === "Enter the creator email." || message === "Enter the creator code."
        ? 400
        : message === "That creator email and code combination already exists."
          ? 409
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
