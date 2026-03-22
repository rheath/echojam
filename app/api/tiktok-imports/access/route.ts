import { NextResponse } from "next/server";
import {
  createTikTokCreatorAccessCookieValue,
  getTikTokCreatorAccessCookieOptions,
  isTikTokImportEnabled,
  validateTikTokCreatorAccessCode,
} from "@/lib/server/tiktokCreatorAccess";

type Body = {
  code?: string | null;
};

export async function POST(req: Request) {
  if (!isTikTokImportEnabled()) {
    return NextResponse.json({ error: "TikTok import is unavailable." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const validation = validateTikTokCreatorAccessCode(body.code);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    "tiktok_creator_access",
    createTikTokCreatorAccessCookieValue(),
    getTikTokCreatorAccessCookieOptions()
  );
  return response;
}
