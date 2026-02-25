import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { resolvePlaceImage } from "@/lib/placesImages";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

type SyncBody = {
  limit?: number;
  maxAgeHours?: number;
  city?: string;
};

type CanonicalStop = {
  id: string;
  city: string;
  title: string;
  lat: number;
  lng: number;
  image_source: "places" | "curated" | "placeholder" | "link_seed";
  image_last_checked_at: string | null;
};

function isAuthorized(req: Request) {
  const expected = process.env.CANONICAL_IMAGE_SYNC_TOKEN;
  if (!expected) return false;
  const provided = req.headers.get("x-sync-token");
  return provided === expected;
}

function coerceInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as SyncBody;
    const limit = coerceInt(body.limit, 100, 1, 500);
    const maxAgeHours = coerceInt(body.maxAgeHours, 24 * 7, 1, 24 * 30);
    const city = typeof body.city === "string" && body.city ? body.city : null;
    const staleBefore = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

    const admin = getAdmin();
    let query = admin
      .from("canonical_stops")
      .select("id,city,title,lat,lng,image_source,image_last_checked_at")
      .or(`image_last_checked_at.is.null,image_last_checked_at.lt.${staleBefore}`)
      .neq("image_source", "curated")
      .order("image_last_checked_at", { ascending: true, nullsFirst: true })
      .limit(limit);

    if (city) query = query.eq("city", city);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as CanonicalStop[];
    let updated = 0;
    let checked = 0;
    const failures: Array<{ id: string; reason: string }> = [];

    for (const row of rows) {
      checked += 1;
      try {
        const resolved = await resolvePlaceImage({
          title: row.title,
          lat: row.lat,
          lng: row.lng,
          city: row.city,
        });

        if (!resolved) {
          await admin
            .from("canonical_stops")
            .update({ image_last_checked_at: new Date().toISOString() })
            .eq("id", row.id);
          continue;
        }

        const { error: updateErr } = await admin
          .from("canonical_stops")
          .update({
            image_url: resolved.imageUrl,
            google_place_id: resolved.placeId,
            image_source: "places",
            image_last_checked_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (updateErr) throw new Error(updateErr.message);
        updated += 1;
      } catch (e) {
        failures.push({
          id: row.id,
          reason: e instanceof Error ? e.message : "Unknown sync error",
        });
        await admin
          .from("canonical_stops")
          .update({ image_last_checked_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }

    return NextResponse.json({
      checked,
      updated,
      failed: failures.length,
      failures,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to sync canonical images" }, { status: 500 });
  }
}
