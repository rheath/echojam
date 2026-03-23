import { NextResponse } from "next/server";
import { getJourneyAccess, getJourneyOfferingBySlug } from "@/lib/server/journeyAccess";
import { getRequestAuthUser } from "@/lib/server/requestAuth";
import { getSiteBaseUrl } from "@/lib/server/siteUrl";
import { createStripeCheckoutSession } from "@/lib/server/stripe";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const user = await getRequestAuthUser(req);
    if (!user) {
      return NextResponse.json({ error: "Sign in before checkout." }, { status: 401 });
    }

    const { slug } = await ctx.params;
    const offering = await getJourneyOfferingBySlug(slug);
    if (!offering) {
      return NextResponse.json({ error: "Journey not found." }, { status: 404 });
    }
    if (!offering.published || offering.pricing.status !== "paid" || typeof offering.pricing.amountUsdCents !== "number") {
      return NextResponse.json({ error: "This journey is not available for purchase." }, { status: 400 });
    }

    const access = await getJourneyAccess({
      userId: user.id,
      sourceKind: offering.sourceKind,
      sourceId: offering.sourceId,
    });
    if (access.accessState === "granted") {
      return NextResponse.json({ error: "You already own this journey." }, { status: 409 });
    }

    const baseUrl = await getSiteBaseUrl();
    const session = await createStripeCheckoutSession({
      title: offering.title,
      description: offering.teaserDescription,
      amountUsdCents: offering.pricing.amountUsdCents,
      purchaserEmail: user.email,
      successUrl: `${baseUrl}/journeys/${encodeURIComponent(offering.slug)}?checkout=success`,
      cancelUrl: `${baseUrl}/journeys/${encodeURIComponent(offering.slug)}?checkout=cancelled`,
      metadata: {
        offering_id: offering.id,
        offering_slug: offering.slug,
        source_kind: offering.sourceKind,
        source_id: offering.sourceId,
        user_id: user.id,
        purchaser_email: user.email ?? "",
      },
    });

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to start checkout." },
      { status: 500 }
    );
  }
}
