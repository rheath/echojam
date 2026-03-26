import { NextResponse } from "next/server";
import { getInstagramImportRequestAuthorizationState } from "@/lib/server/instagramCreatorAccess";
import { instagramRouteStopIdForDraft, toNullableTrimmed } from "@/lib/instagramImport";
import { getInstagramDraftResponseById } from "@/lib/server/instagramImportWorker";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type RouteRow = {
  id: string;
  title: string | null;
};

type RouteStopRow = {
  stop_id: string;
  position: number;
};

type DraftRow = {
  id: string;
};

export async function GET(req: Request, ctx: { params: Promise<{ routeId: string }> }) {
  const access = await getInstagramImportRequestAuthorizationState(req);
  if (!access.enabled) {
    return NextResponse.json({ error: "Instagram import is unavailable." }, { status: 404 });
  }
  if (!access.authorized) {
    return NextResponse.json(
      { error: access.error || "Creator access required. Enter your code and creator email first." },
      { status: access.status || 401 }
    );
  }

  try {
    const { routeId: rawRouteId } = await ctx.params;
    const routeId = toNullableTrimmed(rawRouteId);
    if (!routeId) {
      return NextResponse.json({ error: "Instagram route was not found." }, { status: 404 });
    }

    const admin = getSupabaseAdminClient();
    const [{ data: route, error: routeErr }, { data: routeStops, error: routeStopsErr }, { data: drafts, error: draftsErr }] =
      await Promise.all([
        admin.from("custom_routes").select("id,title").eq("id", routeId).maybeSingle(),
        admin
          .from("custom_route_stops")
          .select("stop_id,position")
          .eq("route_id", routeId)
          .order("position", { ascending: true }),
        admin
          .from("instagram_import_drafts")
          .select("id")
          .eq("published_route_id", routeId),
      ]);

    if (routeErr) {
      throw new Error(routeErr.message);
    }
    if (!route) {
      return NextResponse.json({ error: "Instagram route was not found." }, { status: 404 });
    }
    if (routeStopsErr) {
      throw new Error(routeStopsErr.message);
    }
    if (draftsErr) {
      throw new Error(draftsErr.message);
    }

    const routeStopRows = (routeStops ?? []) as RouteStopRow[];
    const orderedStopIds = routeStopRows.map((stop) => stop.stop_id);
    const orderByStopId = new Map(orderedStopIds.map((stopId, index) => [stopId, index]));
    const matchingDraftIds = ((drafts ?? []) as DraftRow[])
      .map((draft) => ({
        draftId: draft.id,
        stopId: instagramRouteStopIdForDraft(draft.id),
      }))
      .filter(({ stopId }) => orderByStopId.has(stopId))
      .sort((left, right) => (orderByStopId.get(left.stopId) ?? 0) - (orderByStopId.get(right.stopId) ?? 0))
      .map(({ draftId }) => draftId);

    if (matchingDraftIds.length === 0) {
      return NextResponse.json(
        { error: "This route cannot be reopened in the Instagram uploader." },
        { status: 400 }
      );
    }

    const draftPayloads = await Promise.all(
      matchingDraftIds.map((draftId) => getInstagramDraftResponseById(draftId, admin))
    );

    return NextResponse.json({
      routeId,
      routeTitle: toNullableTrimmed((route as RouteRow).title) || "",
      draftIds: matchingDraftIds,
      drafts: draftPayloads,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reopen the Instagram journey.",
      },
      { status: 500 }
    );
  }
}
