import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Persona } from "@/app/content/salemRoutes";
import type { NearbyPlaceCandidate } from "@/lib/nearbyPlaceResolver";
import { getRequestAuthUser } from "@/lib/server/requestAuth";
import { appendAcceptedNearbyStop } from "@/lib/server/walkDiscovery";
import {
  doesWalkDiscoveryPurchaseMatchCandidate,
  ensureWalkDiscoveryPurchaseRecorded,
  markWalkDiscoveryPurchaseConsumed,
  resolveWalkDiscoveryCheckoutRequirement,
} from "@/lib/server/walkDiscoveryPurchases";
import { buildWalkDiscoveryCandidateKey } from "@/lib/walkDiscovery";

type Body = {
  jamId?: string | null;
  routeId?: string | null;
  persona?: Persona | null;
  candidate?: NearbyPlaceCandidate | null;
  experienceKind?: "mix" | "walk_discovery" | null;
  purchaseKey?: string | null;
  stripeCheckoutSessionId?: string | null;
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function resolveJamId(admin: ReturnType<typeof getAdmin>, body: Body) {
  if (body.jamId?.trim()) return body.jamId.trim();
  if (!body.routeId?.trim()) return null;

  const { data, error } = await admin
    .from("custom_routes")
    .select("jam_id")
    .eq("id", body.routeId.trim())
    .single();
  if (error || !data?.jam_id) {
    throw new Error(error?.message || "Unable to resolve journey for route.");
  }
  return data.jam_id as string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.candidate) {
      return NextResponse.json({ error: "A candidate is required." }, { status: 400 });
    }

    const admin = getAdmin();
    const jamId = await resolveJamId(admin, body);
    if (!jamId) {
      return NextResponse.json({ error: "jamId or routeId is required." }, { status: 400 });
    }

    const purchaseKey = (body.purchaseKey || "").trim();
    const pricing = await resolveWalkDiscoveryCheckoutRequirement({
      admin,
      jamId,
      purchaseKey: purchaseKey || "pending",
    });
    const requiresPurchase = !pricing.isIncluded && !pricing.isFree;

    let purchase: Awaited<ReturnType<typeof ensureWalkDiscoveryPurchaseRecorded>> | null = null;
    if (requiresPurchase) {
      const user = await getRequestAuthUser(req);
      if (!user) {
        return NextResponse.json({ error: "Sign in before checkout." }, { status: 401 });
      }
      if (!purchaseKey) {
        return NextResponse.json(
          { error: "Purchase required before adding this stop." },
          { status: 402 }
        );
      }

      purchase = await ensureWalkDiscoveryPurchaseRecorded({
        admin,
        purchaseKey,
        userId: user.id,
        stripeCheckoutSessionId: body.stripeCheckoutSessionId,
      });
      if (!purchase) {
        return NextResponse.json(
          { error: "Complete checkout before adding this stop." },
          { status: 402 }
        );
      }
      if (
        !doesWalkDiscoveryPurchaseMatchCandidate({
          purchase,
          jamId,
          suggestion: {
            candidateKey: buildWalkDiscoveryCandidateKey(body.candidate),
          },
        })
      ) {
        return NextResponse.json(
          { error: "This payment does not match the selected Wander stop." },
          { status: 400 }
        );
      }

      if (
        purchase.consumed_at &&
        purchase.route_id &&
        purchase.inserted_stop_id &&
        typeof purchase.inserted_stop_index === "number"
      ) {
        return NextResponse.json({
          jamId,
          routeId: purchase.route_id,
          routeRef: `custom:${purchase.route_id}`,
          insertedStopId: purchase.inserted_stop_id,
          insertedStopIndex: purchase.inserted_stop_index,
          source: purchase.source || body.candidate.source,
          distanceMeters: purchase.distance_meters,
        });
      }
    }

    const accepted = await appendAcceptedNearbyStop({
      admin,
      jamId,
      persona: (body.persona || "adult") as Persona,
      candidate: body.candidate,
      experienceKind: body.experienceKind === "walk_discovery" ? "walk_discovery" : "mix",
      generateAssets: false,
    });

    if (purchase) {
      await markWalkDiscoveryPurchaseConsumed({
        admin,
        purchaseId: purchase.id,
        routeId: accepted.routeId,
        insertedStopId: accepted.insertedStopId,
        insertedStopIndex: accepted.insertedStopIndex,
        source: accepted.source,
        distanceMeters: accepted.distanceMeters,
      });
    }

    return NextResponse.json({
      jamId,
      routeId: accepted.routeId,
      routeRef: accepted.routeRef,
      insertedStopId: accepted.insertedStopId,
      insertedStopIndex: accepted.insertedStopIndex,
      source: accepted.source,
      distanceMeters: accepted.distanceMeters,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to accept nearby stop.",
      },
      { status: 500 }
    );
  }
}
