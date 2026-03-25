import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRequestAuthUser } from "@/lib/server/requestAuth";
import { getSiteBaseUrl } from "@/lib/server/siteUrl";
import { createStripeCheckoutSession } from "@/lib/server/stripe";
import {
  buildWalkDiscoveryCheckoutMetadata,
  getWalkDiscoveryCheckoutCopy,
  resolveWalkDiscoveryCheckoutRequirement,
} from "@/lib/server/walkDiscoveryPurchases";

type Body = {
  jamId?: string | null;
  suggestion?: {
    candidateKey?: string | null;
    title?: string | null;
    purchaseKey?: string | null;
  } | null;
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const jamId = (body.jamId || "").trim();
    const purchaseKey = (body.suggestion?.purchaseKey || "").trim();
    const title = (body.suggestion?.title || "").trim();
    const candidateKey = (body.suggestion?.candidateKey || "").trim();
    if (!jamId || !purchaseKey || !title || !candidateKey) {
      return NextResponse.json({ error: "A jam, stop, and purchase key are required." }, { status: 400 });
    }

    const user = await getRequestAuthUser(req);
    if (!user) {
      return NextResponse.json({ error: "Sign in before checkout." }, { status: 401 });
    }

    const admin = getAdmin();
    const pricing = await resolveWalkDiscoveryCheckoutRequirement({
      admin,
      jamId,
      purchaseKey,
    });
    if (pricing.isIncluded || pricing.isFree || typeof pricing.amountUsdCents !== "number") {
      return NextResponse.json({ error: "This Wander stop does not require checkout." }, { status: 400 });
    }

    const baseUrl = await getSiteBaseUrl();
    const successUrl = new URL("/", baseUrl);
    successUrl.searchParams.set("jam", jamId);
    successUrl.searchParams.set("walkDiscoveryCheckout", "success");
    successUrl.searchParams.set("walkDiscoveryPurchaseKey", purchaseKey);
    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

    const cancelUrl = new URL("/", baseUrl);
    cancelUrl.searchParams.set("jam", jamId);
    cancelUrl.searchParams.set("walkDiscoveryCheckout", "cancelled");
    cancelUrl.searchParams.set("walkDiscoveryPurchaseKey", purchaseKey);

    const copy = getWalkDiscoveryCheckoutCopy({
      suggestion: {
        title,
      },
      amountUsdCents: pricing.amountUsdCents,
    });
    const session = await createStripeCheckoutSession({
      title: copy.title,
      description: copy.description,
      amountUsdCents: pricing.amountUsdCents,
      purchaserEmail: user.email,
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
      metadata: buildWalkDiscoveryCheckoutMetadata({
        jamId,
        userId: user.id,
        purchaserEmail: user.email ?? "",
        suggestion: {
          candidateKey,
          title,
          purchaseKey,
        },
        amountUsdCents: pricing.amountUsdCents,
      }),
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
