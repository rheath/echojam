import { NextResponse } from "next/server";
import {
  createInstagramCreatorAccessCookieValue,
  getInstagramCreatorAccessCookieOptions,
  INSTAGRAM_CREATOR_ACCESS_COOKIE_NAME,
  isInstagramImportEnabled,
  validateInstagramCreatorAccessCode,
} from "@/lib/server/instagramCreatorAccess";

type Body = {
  code?: string | null;
};

export async function POST(req: Request) {
  if (!isInstagramImportEnabled()) {
    return NextResponse.json(
      { error: "Instagram import is unavailable." },
      { status: 404 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const validation = validateInstagramCreatorAccessCode(body.code);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error },
      { status: validation.status }
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    INSTAGRAM_CREATOR_ACCESS_COOKIE_NAME,
    createInstagramCreatorAccessCookieValue(),
    getInstagramCreatorAccessCookieOptions()
  );
  return response;
}
