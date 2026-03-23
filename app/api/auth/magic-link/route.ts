import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSiteBaseUrl } from "@/lib/server/siteUrl";

type Body = {
  email?: string | null;
  next?: string | null;
};

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizeNextPath(value: string | null | undefined) {
  const candidate = (value || "").trim();
  if (!candidate.startsWith("/")) return "/";
  if (candidate.startsWith("//")) return "/";
  return candidate;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const email = (body.email || "").trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: "Enter your email address." }, { status: 400 });
    }

    const nextPath = normalizeNextPath(body.next);
    const baseUrl = await getSiteBaseUrl();
    const redirectUrl = new URL("/auth/callback", baseUrl);
    redirectUrl.searchParams.set("next", nextPath);

    const supabaseClient = getSupabaseClient();
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectUrl.toString(),
      },
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to send magic link." },
      { status: 500 }
    );
  }
}
