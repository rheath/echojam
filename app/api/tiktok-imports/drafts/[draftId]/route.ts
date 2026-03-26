import { NextResponse } from "next/server";
import { getTikTokImportRequestAuthorizationState } from "@/lib/server/tiktokCreatorAccess";
import {
  regenerateTikTokDraftForConfirmedPlace,
  getTikTokDraftResponseById,
  updateTikTokDraftById,
} from "@/lib/server/tiktokImportWorker";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type PatchBody = {
  editedTitle?: string | null;
  editedScript?: string | null;
  placeQuery?: string | null;
  regenerateScript?: boolean | null;
  confirmedPlace?:
    | {
        label: string;
        lat: number;
        lng: number;
        imageUrl?: string | null;
        googlePlaceId?: string | null;
      }
    | null;
};

function isFiniteCoord(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 180;
}

export async function GET(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const access = await getTikTokImportRequestAuthorizationState(req);
  if (!access.enabled) {
    return NextResponse.json({ error: "TikTok import is unavailable." }, { status: 404 });
  }
  if (!access.authorized) {
    return NextResponse.json(
      { error: access.error || "Creator access required. Enter your code and creator email first." },
      { status: access.status || 401 }
    );
  }

  try {
    const { draftId } = await ctx.params;
    return NextResponse.json(await getTikTokDraftResponseById(draftId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load TikTok draft" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const access = await getTikTokImportRequestAuthorizationState(req);
  if (!access.enabled) {
    return NextResponse.json({ error: "TikTok import is unavailable." }, { status: 404 });
  }
  if (!access.authorized) {
    return NextResponse.json(
      { error: access.error || "Creator access required. Enter your code and creator email first." },
      { status: access.status || 401 }
    );
  }

  try {
    const { draftId } = await ctx.params;
    const body = (await req.json()) as PatchBody;
    const patch: Record<string, string | number | null> = {};

    if ("editedTitle" in body) patch.edited_title = body.editedTitle?.trim() || null;
    if ("editedScript" in body) patch.edited_script = body.editedScript?.trim() || null;
    if ("placeQuery" in body) patch.place_query = body.placeQuery?.trim() || null;

    if ("confirmedPlace" in body) {
      const confirmedPlace = body.confirmedPlace;
      if (confirmedPlace === null || typeof confirmedPlace === "undefined") {
        patch.confirmed_place_label = null;
        patch.confirmed_place_lat = null;
        patch.confirmed_place_lng = null;
        patch.confirmed_place_image_url = null;
        patch.confirmed_google_place_id = null;
      } else {
        if (
          !confirmedPlace.label?.trim() ||
          !isFiniteCoord(confirmedPlace.lat) ||
          !isFiniteCoord(confirmedPlace.lng)
        ) {
          return NextResponse.json({ error: "Confirmed place is invalid." }, { status: 400 });
        }
        patch.confirmed_place_label = confirmedPlace.label.trim();
        patch.confirmed_place_lat = confirmedPlace.lat;
        patch.confirmed_place_lng = confirmedPlace.lng;
        patch.confirmed_place_image_url = confirmedPlace.imageUrl?.trim() || null;
        patch.confirmed_google_place_id = confirmedPlace.googlePlaceId?.trim() || null;
      }
    }

    const admin = getSupabaseAdminClient();
    const updated = await updateTikTokDraftById(draftId, patch, admin);
    if (body.confirmedPlace && (!updated.content.editedScript || body.regenerateScript === true)) {
      return NextResponse.json(
        await regenerateTikTokDraftForConfirmedPlace(draftId, admin, {
          force: body.regenerateScript === true,
        })
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update TikTok draft" },
      { status: 500 }
    );
  }
}
