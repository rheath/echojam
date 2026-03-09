import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(_: Request, ctx: { params: Promise<{ jamId: string }> }) {
  try {
    const { jamId } = await ctx.params;
    const admin = getAdmin();
    const { data, error } = await admin.rpc("increment_jam_listen_count", { p_jam_id: jamId });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (data === null) {
      return NextResponse.json({ error: "Jam not found" }, { status: 404 });
    }
    const listenCount = typeof data === "number" ? data : typeof data === "string" ? Number(data) : NaN;
    if (!Number.isFinite(listenCount)) {
      return NextResponse.json({ error: "Failed to parse listen count" }, { status: 500 });
    }

    return NextResponse.json({ listen_count: listenCount });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to increment jam listeners" },
      { status: 500 }
    );
  }
}
