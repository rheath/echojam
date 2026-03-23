import "server-only";

import { getPresetRouteSummaryById, getPresetRouteSummaryImage, getPresetRouteSummaryNarratorLabel, getPresetRouteSummaryStopCount } from "@/app/content/presetRouteSummaries";
import { getRouteById } from "@/app/content/salemRoutes";
import type { PresetRouteSummary } from "@/app/content/routeTypes";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

export type JourneySourceKind = "preset" | "custom";
export type JourneyEntitlementStatus = "active" | "refunded" | "revoked";
export type JourneyAccessState = "free" | "granted" | "locked";

export type JourneyOfferingRow = {
  id: string;
  source_kind: JourneySourceKind;
  source_id: string;
  slug: string;
  title: string;
  creator_label: string | null;
  cover_image_url: string | null;
  teaser_description: string | null;
  duration_minutes: number | null;
  stop_count: number | null;
  first_stop_title: string | null;
  pricing_status: "free" | "paid" | "tbd";
  price_usd_cents: number | null;
  published: boolean;
};

export type JourneyOfferingSummary = {
  id: string;
  slug: string;
  title: string;
  creatorLabel: string | null;
  coverImageUrl: string | null;
  teaserDescription: string | null;
  durationMinutes: number | null;
  stopCount: number | null;
  firstStopTitle: string | null;
  pricing: {
    status: "free" | "paid" | "tbd";
    amountUsdCents: number | null;
    displayLabel: string;
  };
  sourceKind: JourneySourceKind;
  sourceId: string;
  published: boolean;
};

export type JourneyAccessResult = {
  accessState: JourneyAccessState;
  requiresPurchase: boolean;
  offering: JourneyOfferingSummary | null;
};

function formatUsdCents(amountUsdCents: number | null | undefined) {
  if (typeof amountUsdCents !== "number" || !Number.isFinite(amountUsdCents)) return "Paid";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amountUsdCents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountUsdCents / 100);
}

function toOfferingSummary(row: JourneyOfferingRow): JourneyOfferingSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    creatorLabel: row.creator_label,
    coverImageUrl: row.cover_image_url,
    teaserDescription: row.teaser_description,
    durationMinutes: row.duration_minutes,
    stopCount: row.stop_count,
    firstStopTitle: row.first_stop_title,
    pricing: {
      status: row.pricing_status,
      amountUsdCents: row.price_usd_cents,
      displayLabel:
        row.pricing_status === "free"
          ? "FREE"
          : row.pricing_status === "paid"
            ? formatUsdCents(row.price_usd_cents)
            : "TBD",
    },
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    published: row.published,
  };
}

function buildDefaultPresetOffering(summary: PresetRouteSummary): Omit<JourneyOfferingRow, "id"> {
  return {
    source_kind: "preset",
    source_id: summary.id,
    slug: summary.id,
    title: summary.title,
    creator_label: getPresetRouteSummaryNarratorLabel(summary),
    cover_image_url: getPresetRouteSummaryImage(summary),
    teaser_description: summary.description,
    duration_minutes: summary.durationMinutes ?? null,
    stop_count: getPresetRouteSummaryStopCount(summary),
    first_stop_title: summary.firstStopTitle ?? null,
    pricing_status: summary.pricing?.status ?? "tbd",
    price_usd_cents:
      typeof summary.pricing?.amountUsdCents === "number" ? summary.pricing.amountUsdCents : null,
    published: summary.requiresPurchase,
  };
}

async function upsertDefaultPresetOffering(summary: PresetRouteSummary) {
  const admin = getSupabaseAdminClient();
  const defaults = buildDefaultPresetOffering(summary);
  const { data, error } = await admin
    .from("journey_offerings")
    .upsert(defaults, { onConflict: "source_kind,source_id" })
    .select(
      "id,source_kind,source_id,slug,title,creator_label,cover_image_url,teaser_description,duration_minutes,stop_count,first_stop_title,pricing_status,price_usd_cents,published"
    )
    .single();
  if (error || !data) {
    throw new Error(error?.message || "Failed to create default journey offering.");
  }
  return data as JourneyOfferingRow;
}

async function getOfferingRowByQuery(column: "slug" | "source_id", value: string, sourceKind?: JourneySourceKind) {
  const admin = getSupabaseAdminClient();
  let query = admin
    .from("journey_offerings")
    .select(
      "id,source_kind,source_id,slug,title,creator_label,cover_image_url,teaser_description,duration_minutes,stop_count,first_stop_title,pricing_status,price_usd_cents,published"
    )
    .eq(column, value);
  if (sourceKind) {
    query = query.eq("source_kind", sourceKind);
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? null) as JourneyOfferingRow | null;
}

export async function getJourneyOfferingBySource(
  sourceKind: JourneySourceKind,
  sourceId: string
): Promise<JourneyOfferingSummary | null> {
  const existing = await getOfferingRowByQuery("source_id", sourceId, sourceKind);
  if (existing) return toOfferingSummary(existing);

  if (sourceKind !== "preset") return null;
  const summary = getPresetRouteSummaryById(sourceId);
  if (!summary?.requiresPurchase) return null;
  const row = await upsertDefaultPresetOffering(summary);
  return toOfferingSummary(row);
}

export async function getJourneyOfferingBySlug(slug: string): Promise<JourneyOfferingSummary | null> {
  const existing = await getOfferingRowByQuery("slug", slug);
  if (existing) return toOfferingSummary(existing);

  const summary = getPresetRouteSummaryById(slug);
  if (!summary?.requiresPurchase) return null;
  const row = await upsertDefaultPresetOffering(summary);
  return toOfferingSummary(row);
}

export async function getJourneyAccess(params: {
  userId?: string | null;
  sourceKind: JourneySourceKind;
  sourceId: string;
}): Promise<JourneyAccessResult> {
  const presetSummary =
    params.sourceKind === "preset" ? getPresetRouteSummaryById(params.sourceId) : null;

  if (params.sourceKind === "preset" && !presetSummary) {
    return {
      accessState: "locked",
      requiresPurchase: false,
      offering: null,
    };
  }

  if (!presetSummary?.requiresPurchase) {
    return {
      accessState: "free",
      requiresPurchase: false,
      offering: null,
    };
  }

  const offering = await getJourneyOfferingBySource(params.sourceKind, params.sourceId);
  if (!offering || !offering.published || offering.pricing.status !== "paid") {
    return {
      accessState: "locked",
      requiresPurchase: true,
      offering,
    };
  }

  if (!params.userId) {
    return {
      accessState: "locked",
      requiresPurchase: true,
      offering,
    };
  }

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("journey_entitlements")
    .select("id")
    .eq("offering_id", offering.id)
    .eq("user_id", params.userId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }

  return {
    accessState: data ? "granted" : "locked",
    requiresPurchase: true,
    offering,
  };
}

export async function getJourneyOfferingForPresetRoute(routeId: string) {
  const route = getRouteById(routeId);
  if (!route || route.pricing?.status !== "paid") return null;
  return getJourneyOfferingBySource("preset", routeId);
}
