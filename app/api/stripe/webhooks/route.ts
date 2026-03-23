import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";
import { getStripeWebhookSecret, verifyStripeWebhookSignature, type StripeCheckoutCompletedEvent } from "@/lib/server/stripe";

function isDuplicateKeyError(code: string | undefined) {
  return code === "23505";
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
    }

    verifyStripeWebhookSignature(rawBody, signature, getStripeWebhookSecret());
    const event = JSON.parse(rawBody) as StripeCheckoutCompletedEvent;
    const admin = getSupabaseAdminClient();

    const { error: eventInsertError } = await admin.from("stripe_webhook_events").insert({
      stripe_event_id: event.id,
      event_type: event.type,
      payload: event,
    });
    if (eventInsertError && !isDuplicateKeyError(eventInsertError.code)) {
      throw new Error(eventInsertError.message);
    }
    if (eventInsertError && isDuplicateKeyError(eventInsertError.code)) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const offeringId = session.metadata?.offering_id?.trim();
      const userId = session.metadata?.user_id?.trim();
      const purchaserEmail =
        session.customer_details?.email?.trim() ||
        session.metadata?.purchaser_email?.trim() ||
        "";

      if (offeringId && userId && purchaserEmail) {
        const { error } = await admin.from("journey_entitlements").upsert(
          {
            offering_id: offeringId,
            user_id: userId,
            purchaser_email: purchaserEmail,
            status: "active",
            stripe_checkout_session_id: session.id,
          },
          { onConflict: "offering_id,user_id" }
        );
        if (error) {
          throw new Error(error.message);
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to process Stripe webhook." },
      { status: 400 }
    );
  }
}
