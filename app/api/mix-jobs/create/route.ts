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

type CreateBody = {
  jamId?: string | null;
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
        let prepared;
        try {
          prepared = await prepareCustomRouteJob({
            admin,
            jamId: body.jamId ?? null,
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
            body.jamId
          ) {
            const { data: activeJob } = await admin
              .from("mix_generation_jobs")
              .select("id,status")
              .eq("jam_id", body.jamId)
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

        after(async () => {
          try {
            await runCustomRouteGeneration(
              admin,
              prepared.jobId,
              prepared.routeId,
              prepared.city,
              prepared.transportMode,
              prepared.lengthMinutes,
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
