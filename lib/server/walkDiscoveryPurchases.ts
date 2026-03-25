import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WalkDiscoverySuggestion } from "@/lib/walkDiscovery";
import {
  retrieveStripeCheckoutSession,
  type StripeCheckoutSessionRecord,
} from "@/lib/server/stripe";
import { formatUsdCents, getWalkDiscoveryPricingConfig, resolveWalkDiscoverySuggestionPricing } from "@/lib/server/walkDiscoveryPricing";

export type WalkDiscoveryPurchaseRow = {
  id: string;
  purchase_key: string;
  user_id: string;
  jam_id: string;
  candidate_key: string;
  candidate_title: string;
  purchaser_email: string;
  amount_usd_cents: number;
  status: "active" | "refunded" | "revoked";
  stripe_checkout_session_id: string;
  route_id: string | null;
  inserted_stop_id: string | null;
  inserted_stop_index: number | null;
  source: string | null;
  distance_meters: number | null;
  consumed_at: string | null;
};

function parseAmount(value: string | null | undefined) {
  const parsed = Number.parseInt((value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toNullableString(value: string | null | undefined) {
  const trimmed = (value || "").trim();
  return trimmed || null;
}

function isWalkDiscoveryCheckoutSession(session: Pick<StripeCheckoutSessionRecord, "metadata" | "paymentStatus">) {
  return session.metadata?.product_kind?.trim() === "walk_discovery_stop" && session.paymentStatus === "paid";
}

export async function countAcceptedWalkDiscoveryStops(admin: SupabaseClient, jamId: string) {
  const { data: jam, error: jamError } = await admin
    .from("jams")
    .select("route_id")
    .eq("id", jamId)
    .maybeSingle();
  if (jamError) throw new Error(jamError.message);

  const routeRef = (jam?.route_id || "").trim();
  if (!routeRef.startsWith("custom:")) return 0;

  const customRouteId = routeRef.slice("custom:".length).trim();
  if (!customRouteId) return 0;

  const { count, error: countError } = await admin
    .from("custom_route_stops")
    .select("stop_id", { count: "exact", head: true })
    .eq("route_id", customRouteId);
  if (countError) throw new Error(countError.message);
  return count ?? 0;
}

export function buildWalkDiscoveryCheckoutMetadata(args: {
  jamId: string;
  userId: string;
  purchaserEmail: string;
  suggestion: Pick<WalkDiscoverySuggestion, "candidateKey" | "title" | "purchaseKey">;
  amountUsdCents: number;
}) {
  return {
    product_kind: "walk_discovery_stop",
    jam_id: args.jamId,
    user_id: args.userId,
    purchaser_email: args.purchaserEmail,
    purchase_key: args.suggestion.purchaseKey,
    candidate_key: args.suggestion.candidateKey,
    candidate_title: args.suggestion.title,
    amount_usd_cents: String(args.amountUsdCents),
  };
}

export function getWalkDiscoveryCheckoutCopy(args: {
  suggestion: Pick<WalkDiscoverySuggestion, "title">;
  amountUsdCents: number;
}) {
  const amountLabel = formatUsdCents(args.amountUsdCents);
  return {
    title: `Add ${args.suggestion.title}`,
    description: `One extra Wander stop for ${amountLabel}.`,
  };
}

export async function getWalkDiscoveryPurchaseByKey(
  admin: SupabaseClient,
  purchaseKey: string,
  userId: string
) {
  const { data, error } = await admin
    .from("walk_discovery_purchases")
    .select(
      "id,purchase_key,user_id,jam_id,candidate_key,candidate_title,purchaser_email,amount_usd_cents,status,stripe_checkout_session_id,route_id,inserted_stop_id,inserted_stop_index,source,distance_meters,consumed_at"
    )
    .eq("purchase_key", purchaseKey)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as WalkDiscoveryPurchaseRow | null;
}

export async function upsertWalkDiscoveryPurchase(
  admin: SupabaseClient,
  row: Omit<WalkDiscoveryPurchaseRow, "id" | "route_id" | "inserted_stop_id" | "inserted_stop_index" | "source" | "distance_meters" | "consumed_at"> &
    Partial<Pick<WalkDiscoveryPurchaseRow, "route_id" | "inserted_stop_id" | "inserted_stop_index" | "source" | "distance_meters" | "consumed_at">>
) {
  const { data, error } = await admin
    .from("walk_discovery_purchases")
    .upsert(row, { onConflict: "purchase_key" })
    .select(
      "id,purchase_key,user_id,jam_id,candidate_key,candidate_title,purchaser_email,amount_usd_cents,status,stripe_checkout_session_id,route_id,inserted_stop_id,inserted_stop_index,source,distance_meters,consumed_at"
    )
    .single();
  if (error || !data) {
    throw new Error(error?.message || "Failed to save paid Wander stop purchase.");
  }
  return data as WalkDiscoveryPurchaseRow;
}

export async function recordWalkDiscoveryPurchaseFromCheckoutSession(
  admin: SupabaseClient,
  session: StripeCheckoutSessionRecord
) {
  if (!isWalkDiscoveryCheckoutSession(session)) return null;

  const purchaseKey = toNullableString(session.metadata?.purchase_key);
  const userId = toNullableString(session.metadata?.user_id);
  const jamId = toNullableString(session.metadata?.jam_id);
  const candidateKey = toNullableString(session.metadata?.candidate_key);
  const candidateTitle = toNullableString(session.metadata?.candidate_title);
  const purchaserEmail =
    toNullableString(session.customerDetails?.email) ??
    toNullableString(session.metadata?.purchaser_email);
  const amountUsdCents = parseAmount(session.metadata?.amount_usd_cents);

  if (
    !purchaseKey ||
    !userId ||
    !jamId ||
    !candidateKey ||
    !candidateTitle ||
    !purchaserEmail ||
    amountUsdCents === null
  ) {
    throw new Error("Stripe session metadata for walk discovery purchase is incomplete.");
  }

  return upsertWalkDiscoveryPurchase(admin, {
    purchase_key: purchaseKey,
    user_id: userId,
    jam_id: jamId,
    candidate_key: candidateKey,
    candidate_title: candidateTitle,
    purchaser_email: purchaserEmail,
    amount_usd_cents: amountUsdCents,
    status: "active",
    stripe_checkout_session_id: session.id,
  });
}

export async function ensureWalkDiscoveryPurchaseRecorded(args: {
  admin: SupabaseClient;
  purchaseKey: string;
  userId: string;
  stripeCheckoutSessionId?: string | null;
}) {
  const existing = await getWalkDiscoveryPurchaseByKey(args.admin, args.purchaseKey, args.userId);
  if (existing) return existing;

  const sessionId = toNullableString(args.stripeCheckoutSessionId);
  if (!sessionId) return null;

  const session = await retrieveStripeCheckoutSession(sessionId);
  const recorded = await recordWalkDiscoveryPurchaseFromCheckoutSession(args.admin, session);
  if (!recorded) return null;
  if (recorded.user_id !== args.userId || recorded.purchase_key !== args.purchaseKey) {
    throw new Error("Stripe session does not match this Wander purchase.");
  }
  return recorded;
}

export async function resolveWalkDiscoveryCheckoutRequirement(args: {
  admin: SupabaseClient;
  jamId: string;
  purchaseKey: string;
}) {
  const acceptedStopCount = await countAcceptedWalkDiscoveryStops(args.admin, args.jamId);
  return resolveWalkDiscoverySuggestionPricing({
    acceptedStopCount,
    purchaseKey: args.purchaseKey,
    config: getWalkDiscoveryPricingConfig(),
  });
}

export async function markWalkDiscoveryPurchaseConsumed(args: {
  admin: SupabaseClient;
  purchaseId: string;
  routeId: string;
  insertedStopId: string;
  insertedStopIndex: number;
  source: string;
  distanceMeters: number | null;
}) {
  const { error } = await args.admin
    .from("walk_discovery_purchases")
    .update({
      route_id: args.routeId,
      inserted_stop_id: args.insertedStopId,
      inserted_stop_index: args.insertedStopIndex,
      source: args.source,
      distance_meters: args.distanceMeters,
      consumed_at: new Date().toISOString(),
    })
    .eq("id", args.purchaseId);
  if (error) throw new Error(error.message);
}

export function doesWalkDiscoveryPurchaseMatchCandidate(args: {
  purchase: Pick<WalkDiscoveryPurchaseRow, "candidate_key" | "jam_id">;
  jamId: string;
  suggestion: Pick<WalkDiscoverySuggestion, "candidateKey">;
}) {
  return args.purchase.jam_id === args.jamId && args.purchase.candidate_key === args.suggestion.candidateKey;
}
