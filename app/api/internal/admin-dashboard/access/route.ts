import { NextResponse } from "next/server";
import { sendCreatorAccessMagicLink } from "@/lib/server/creatorAccess";
import { validateCreatorCodeDashboardMagicLinkEmail } from "@/lib/server/internalAdminAccess";

type Body = {
  email?: string | null;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const validation = validateCreatorCodeDashboardMagicLinkEmail(body.email);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    await sendCreatorAccessMagicLink({
      email: validation.normalizedEmail,
      nextPath: "/internal/admin-dashboard",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send admin magic link." },
      { status: 500 }
    );
  }
}
