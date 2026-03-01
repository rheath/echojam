import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const JOB_STATUS_TIMEOUT_MS = 7000;

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(_: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await ctx.params;
    const admin = getAdmin();
    const lookupPromise = admin
      .from("preset_generation_jobs")
      .select("id,status,progress,message,error,jam_id,preset_route_id,updated_at")
      .eq("id", jobId)
      .single();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("JOB_STATUS_TIMEOUT")), JOB_STATUS_TIMEOUT_MS);
    });
    const { data, error } = await Promise.race([lookupPromise, timeoutPromise]);
    if (error) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({
      ...data,
      route_id: data.preset_route_id,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "JOB_STATUS_TIMEOUT") {
      const { jobId } = await ctx.params;
      console.warn(`preset job status timeout: jobId=${jobId}`);
      return NextResponse.json({ error: "Job status lookup timed out" }, { status: 504 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load preset job" }, { status: 500 });
  }
}
