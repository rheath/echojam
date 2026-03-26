import { NextResponse } from "next/server";
import {
  isInstagramImportEnabled,
} from "@/lib/server/instagramCreatorAccess";
import {
  CREATOR_ACCESS_PENDING_COOKIE_NAME,
  createPendingCreatorAccessClaimCookieValue,
  getPendingCreatorAccessCookieOptions,
  sendCreatorAccessMagicLink,
  validateCreatorAccessStart,
} from "@/lib/server/creatorAccess";

type Body = {
  code?: string | null;
  email?: string | null;
  next?: string | null;
};

export async function POST(req: Request) {
  if (!isInstagramImportEnabled()) {
    return NextResponse.json(
      { error: "Instagram import is unavailable." },
      { status: 404 }
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const validation = await validateCreatorAccessStart({
      code: body.code,
      email: body.email,
      next: body.next,
      requestedScope: "mixed",
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    await sendCreatorAccessMagicLink({
      email: validation.normalizedEmail,
      nextPath: validation.nextPath,
    });

    const response = NextResponse.json({ ok: true });
    response.cookies.set(
      CREATOR_ACCESS_PENDING_COOKIE_NAME,
      createPendingCreatorAccessClaimCookieValue({
        inviteId: validation.invite.id,
        email: validation.normalizedEmail,
        requestedScope: validation.requestedScope,
        nextPath: validation.nextPath,
      }),
      getPendingCreatorAccessCookieOptions()
    );
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to unlock Instagram uploader." },
      { status: 500 }
    );
  }
}
