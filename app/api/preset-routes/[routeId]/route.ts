import { NextResponse } from "next/server";
import { getPresetRouteSummaryById } from "@/app/content/presetRouteSummaries";
import { getJourneyAccess } from "@/lib/server/journeyAccess";
import { loadPresetRoutePayload } from "@/lib/server/presetRoutePayload";
import { getRequestAuthUser } from "@/lib/server/requestAuth";

export async function GET(req: Request, ctx: { params: Promise<{ routeId: string }> }) {
  try {
    const { routeId } = await ctx.params;
    const summary = getPresetRouteSummaryById(routeId);
    if (!summary) {
      return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });
    }

    const user = await getRequestAuthUser(req);
    const access = await getJourneyAccess({
      userId: user?.id ?? null,
      sourceKind: "preset",
      sourceId: routeId,
    });
    if (access.accessState === "locked") {
      return NextResponse.json(
        {
          access: "locked",
          teaser: access.offering
            ? {
                slug: access.offering.slug,
                title: access.offering.title,
                creatorLabel: access.offering.creatorLabel,
                coverImageUrl: access.offering.coverImageUrl,
                teaserDescription: access.offering.teaserDescription,
                durationMinutes: access.offering.durationMinutes,
                stopCount: access.offering.stopCount,
                firstStopTitle: access.offering.firstStopTitle,
                pricing: access.offering.pricing,
              }
            : null,
        },
        { status: 402 }
      );
    }

    const cityParam = new URL(req.url).searchParams.get("city");
    const payload = await loadPresetRoutePayload(routeId, cityParam);
    if (!payload) {
      return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });
    }

    return NextResponse.json({
      access: "granted",
      ...payload,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load preset route" },
      { status: 500 }
    );
  }
}
