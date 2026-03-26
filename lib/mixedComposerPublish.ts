import type { SupabaseClient } from "@supabase/supabase-js";
import type { TransportMode } from "@/lib/mixConstraints";
import type { Persona, StopInput } from "@/lib/mixGeneration";
import { toNullableTrimmed } from "@/lib/instagramImport";

export type MixedComposerPublishTarget = {
  jamId: string;
  routeId: string;
};

type MixedComposerPublishTargetRow = {
  id: string;
  jam_id: string;
};

export type MixedComposerCreateMixRequest = {
  mixedComposerSessionId: string;
  jamId?: string;
  city: string;
  transportMode: TransportMode;
  lengthMinutes: number;
  persona: Persona;
  stops: StopInput[];
  source?: "manual" | "instant" | "follow_along";
  routeTitle?: string | null;
  narratorGuidance?: string | null;
  routeAttribution?: {
    storyBy?: string | null;
    storyByUrl?: string | null;
    storyByAvatarUrl?: string | null;
    storyBySource?: "instagram" | "tiktok" | "social" | null;
  } | null;
};

export function normalizeMixedComposerPublishTarget(
  value:
    | {
        jamId?: string | null;
        routeId?: string | null;
      }
    | null
    | undefined
) {
  const jamId = toNullableTrimmed(value?.jamId);
  const routeId = toNullableTrimmed(value?.routeId);
  if (!jamId || !routeId) return null;
  return { jamId, routeId } satisfies MixedComposerPublishTarget;
}

export async function loadLatestMixedComposerPublishTarget(
  admin: SupabaseClient,
  sessionId: string | null | undefined
) {
  const normalizedSessionId = toNullableTrimmed(sessionId);
  if (!normalizedSessionId) return null;

  const { data, error } = await admin
    .from("custom_routes")
    .select("id,jam_id")
    .eq("mixed_composer_session_id", normalizedSessionId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as MixedComposerPublishTargetRow;
  return normalizeMixedComposerPublishTarget({
    jamId: row.jam_id,
    routeId: row.id,
  });
}

export function buildMixedComposerCreateMixRequest(
  args: Omit<MixedComposerCreateMixRequest, "jamId"> & {
    publishTarget?: Partial<MixedComposerPublishTarget> | null;
  }
) {
  const publishTarget = normalizeMixedComposerPublishTarget(args.publishTarget);
  return {
    ...(publishTarget ? { jamId: publishTarget.jamId } : {}),
    mixedComposerSessionId: args.mixedComposerSessionId,
    city: args.city,
    transportMode: args.transportMode,
    lengthMinutes: args.lengthMinutes,
    persona: args.persona,
    stops: args.stops,
    source: args.source,
    routeTitle: args.routeTitle,
    narratorGuidance: args.narratorGuidance,
    routeAttribution: args.routeAttribution,
  } satisfies MixedComposerCreateMixRequest;
}
