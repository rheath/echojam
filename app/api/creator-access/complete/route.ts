import { NextResponse } from "next/server";
import {
  applyCreatorAccessCookies,
  clearCreatorAccessPendingCookie,
  completeCreatorAccessClaim,
} from "@/lib/server/creatorAccess";

export async function POST(req: Request) {
  try {
    const result = await completeCreatorAccessClaim(req);
    if (!result.ok) {
      const response = NextResponse.json({ error: result.error }, { status: result.status });
      clearCreatorAccessPendingCookie(response);
      return response;
    }

    const response = NextResponse.json({
      ok: true,
      authorized: result.scopes.length > 0,
      scopes: result.scopes,
    });
    if (result.scopes.length > 0) {
      applyCreatorAccessCookies(response, result.scopes);
    }
    clearCreatorAccessPendingCookie(response);
    return response;
  } catch (error) {
    const response = NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to complete creator access." },
      { status: 500 }
    );
    clearCreatorAccessPendingCookie(response);
    return response;
  }
}
