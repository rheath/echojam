import { after, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  selectCustomNarratorVoice,
  toNullableTrimmed,
  type Persona,
  type StopInput,
} from "@/lib/mixGeneration";
import { type TransportMode } from "@/lib/mixConstraints";
import {
  prepareCustomRouteJob,
  type CustomRouteExperienceKind,
  runCustomRouteGeneration,
} from "@/lib/customRouteGeneration";
import { ensureCreatorAccess } from "@/lib/server/creatorAccess";
import { getOwnedMixedComposerSessionById } from "@/lib/server/mixedComposerOwnership";

type CreateBody = {
  jamId?: string | null;
  mixedComposerSessionId?: string | null;
  city: string;
  transportMode: TransportMode;
  lengthMinutes: number;
  persona: Persona;
  stops: StopInput[];
  source?: "manual" | "instant" | "follow_along";
  routeTitle?: string | null;
  narratorGuidance?: string | null;
  experienceKind?: CustomRouteExperienceKind | null;
  routeAttribution?: {
    storyBy?: string | null;
    storyByUrl?: string | null;
    storyByAvatarUrl?: string | null;
    storyBySource?: "instagram" | "tiktok" | "social" | null;
  } | null;
};

const CREATE_JOB_REQUEST_TIMEOUT_MS = 12000;

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
    const timeoutResponse = new Promise<NextResponse>((resolve) => {
      setTimeout(() => {
        console.warn("mix-jobs/create timed out before responding");
        resolve(
          NextResponse.json(
            { error: "Timed out creating mix job" },
            { status: 504 }
          )
        );
      }, CREATE_JOB_REQUEST_TIMEOUT_MS);
    });

    const createResponse = await Promise.race([
      (async () => {
        const body = (await req.json()) as CreateBody;
        const narratorGuidance = toNullableTrimmed(body.narratorGuidance);

        const admin = getAdmin();
        const mixedComposerSessionId = toNullableTrimmed(body.mixedComposerSessionId);
        const mixedAccess = mixedComposerSessionId ? await ensureCreatorAccess(req, "mixed") : null;
        if (mixedComposerSessionId && mixedAccess && !mixedAccess.ok) {
          return NextResponse.json(
            { error: mixedAccess.error },
            { status: mixedAccess.status }
          );
        }
        const authUser = mixedAccess && mixedAccess.ok ? mixedAccess.authUser : null;

        const ownedSession =
          mixedComposerSessionId && authUser
            ? await getOwnedMixedComposerSessionById(admin, mixedComposerSessionId, authUser.id)
            : null;
        if (mixedComposerSessionId && !ownedSession) {
          return NextResponse.json(
            { error: "That private journey draft was not found." },
            { status: 404 }
          );
        }

        const resolvedJamId =
          toNullableTrimmed(body.jamId) || toNullableTrimmed(ownedSession?.jam_id) || null;
        if (
          mixedComposerSessionId &&
          toNullableTrimmed(body.jamId) &&
          toNullableTrimmed(ownedSession?.jam_id) &&
          toNullableTrimmed(body.jamId) !== toNullableTrimmed(ownedSession?.jam_id)
        ) {
          return NextResponse.json(
            { error: "This draft does not belong to the selected journey." },
            { status: 403 }
          );
        }

        let prepared;
        try {
          prepared = await prepareCustomRouteJob({
            admin,
            jamId: resolvedJamId,
            mixedComposerSessionId,
            ownerUserId: authUser?.id ?? null,
            createRouteRevision: Boolean(mixedComposerSessionId && resolvedJamId),
            city: body.city,
            transportMode: body.transportMode,
            lengthMinutes: body.lengthMinutes,
            persona: body.persona,
            stops: body.stops,
            source: body.source,
            routeTitle: body.routeTitle,
            narratorGuidance,
            experienceKind: body.experienceKind ?? "mix",
            routeAttribution: body.routeAttribution ?? undefined,
          });
        } catch (e) {
          if (
            e instanceof Error &&
            e.message === "A generation job is already in progress for this jam." &&
            resolvedJamId
          ) {
            const { data: activeJob } = await admin
              .from("mix_generation_jobs")
              .select("id,status")
              .eq("jam_id", resolvedJamId)
              .in("status", ["queued", "generating_script", "generating_audio"])
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (activeJob?.id) {
              return NextResponse.json(
                {
                  error: e.message,
                  jobId: activeJob.id,
                  status: activeJob.status,
                },
                { status: 429 }
              );
            }
          }

          return NextResponse.json(
            {
              error: e instanceof Error ? e.message : "Failed to create mix job",
            },
            { status: 400 }
          );
        }

        const narratorVoice =
          prepared.persona === "custom" && prepared.narratorGuidance
            ? selectCustomNarratorVoice(prepared.narratorGuidance)
            : null;

        if (mixedComposerSessionId) {
          await admin
            .from("mixed_composer_sessions")
            .update({
              jam_id: prepared.jamId,
              draft_status: "publishing",
            })
            .eq("id", mixedComposerSessionId)
            .eq("owner_user_id", authUser?.id ?? null);
        }

        after(async () => {
          try {
            await runCustomRouteGeneration(
              admin,
              prepared.jobId,
              prepared.routeId,
              prepared.city,
              prepared.transportMode,
              prepared.lengthMinutes,
              prepared.experienceKind,
              prepared.persona,
              prepared.stops,
              prepared.narratorGuidance,
              narratorVoice
            );
          } catch (e) {
            console.error("mix job generation failed", {
              jobId: prepared.jobId,
              routeId: prepared.routeId,
              error: e,
            });
            await admin
              .from("custom_routes")
              .update({ status: "failed" })
              .eq("id", prepared.routeId);
            await admin
              .from("mix_generation_jobs")
              .update({
                status: "failed",
                message: "Generation failed",
                error: e instanceof Error ? e.message : "Unknown error",
              })
              .eq("id", prepared.jobId);
            if (mixedComposerSessionId && authUser) {
              await admin
                .from("mixed_composer_sessions")
                .update({ draft_status: "draft" })
                .eq("id", mixedComposerSessionId)
                .eq("owner_user_id", authUser.id);
            }
          }
        });

        return NextResponse.json({
          jamId: prepared.jamId,
          routeId: prepared.routeId,
          routeRef: prepared.routeRef,
          jobId: prepared.jobId,
        });
      })(),
      timeoutResponse,
    ]);

    return createResponse;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create mix job" },
      { status: 500 }
    );
  }
}
