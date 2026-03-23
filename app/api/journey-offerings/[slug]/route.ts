import { NextResponse } from "next/server";
import { getJourneyAccess, getJourneyOfferingBySlug } from "@/lib/server/journeyAccess";
import { loadPresetRoutePayload, loadPresetRoutePreviewStops } from "@/lib/server/presetRoutePayload";
import { getRequestAuthUser } from "@/lib/server/requestAuth";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const offering = await getJourneyOfferingBySlug(slug);
    if (!offering) {
      return NextResponse.json({ error: "Journey not found." }, { status: 404 });
    }

    const user = await getRequestAuthUser(req);
    const access = await getJourneyAccess({
      userId: user?.id ?? null,
      sourceKind: offering.sourceKind,
      sourceId: offering.sourceId,
    });

    if (access.accessState === "locked") {
      const previewStops =
        offering.sourceKind === "preset"
          ? (await loadPresetRoutePreviewStops(offering.sourceId)) ?? []
          : [];
      return NextResponse.json({
        access: "locked",
        teaser: access.offering,
        previewStops,
      });
    }

    if (offering.sourceKind === "preset") {
      const payload = await loadPresetRoutePayload(offering.sourceId);
      if (!payload) {
        return NextResponse.json({ error: "Journey route not found." }, { status: 404 });
      }
      return NextResponse.json({
        access: "granted",
        teaser: access.offering,
        ...payload,
      });
    }

    return NextResponse.json({ error: "Unsupported journey source." }, { status: 501 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load journey." },
      { status: 500 }
    );
  }
}
