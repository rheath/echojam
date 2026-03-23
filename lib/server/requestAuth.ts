import "server-only";

import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

export type RequestAuthUser = {
  id: string;
  email: string | null;
};

function getBearerToken(request: Request) {
  const header = (request.headers.get("authorization") || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice("bearer ".length).trim();
  return token || null;
}

export async function getRequestAuthUser(request: Request): Promise<RequestAuthUser | null> {
  const token = getBearerToken(request);
  if (!token) return null;

  try {
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return null;
    return {
      id: data.user.id,
      email: data.user.email?.trim() || null,
    };
  } catch {
    return null;
  }
}
