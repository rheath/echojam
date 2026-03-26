import { NextResponse } from "next/server";
import {
  applyCreatorAccessCookies,
  getCreatorAccessStatus,
  normalizeCreatorAccessRequestedScope,
} from "@/lib/server/creatorAccess";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const scope = normalizeCreatorAccessRequestedScope(url.searchParams.get("scope"));
    if (!scope) {
      return NextResponse.json({ error: "Choose a valid creator access flow." }, { status: 400 });
    }

    const status = await getCreatorAccessStatus(req, scope);
    if (!status.authUser) {
      return NextResponse.json({ authorized: false }, { status: 401 });
    }

    const response = NextResponse.json({
      authorized: status.authorized,
      email: status.authUser.email,
      scopes: status.inviteScopes,
    });
    if (status.inviteScopes.length > 0) {
      applyCreatorAccessCookies(response, status.inviteScopes);
    }
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load creator access." },
      { status: 500 }
    );
  }
}
