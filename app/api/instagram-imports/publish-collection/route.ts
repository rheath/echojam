import { after, NextResponse } from "next/server";
import {
  INSTAGRAM_COLLECTION_MAX_STOPS,
  canMasterPublishInstagramDrafts,
  normalizeInstagramCollectionDraftIds,
  toNullableTrimmed,
} from "@/lib/instagramImport";
import { getInstagramImportRequestAuthorizationState } from "@/lib/server/instagramCreatorAccess";
import {
  createInstagramImportJob,
  getInstagramDraftIdsMigrationError,
  getInstagramDraftResponseById,
  processQueuedInstagramImportJobs,
} from "@/lib/server/instagramImportWorker";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type Body = {
  draftIds?: string[];
  routeTitle?: string | null;
  existingRouteId?: string | null;
};

function sameOrderedIds(left: string[] | null | undefined, right: string[]) {
  const normalizedLeft = normalizeInstagramCollectionDraftIds(left ?? [], INSTAGRAM_COLLECTION_MAX_STOPS);
  if (normalizedLeft.length !== right.length) return false;
  return normalizedLeft.every((value, index) => value === right[index]);
}

export async function POST(req: Request) {
  const access = getInstagramImportRequestAuthorizationState(req);
  if (!access.enabled) {
    return NextResponse.json({ error: "Instagram import is unavailable." }, { status: 404 });
  }
  if (!access.authorized) {
    return NextResponse.json(
      { error: "Enter a valid creator code to use the Instagram uploader." },
      { status: 401 }
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const requestedDraftIds = Array.isArray(body.draftIds)
      ? body.draftIds.map((value) => toNullableTrimmed(value)).filter((value): value is string => Boolean(value))
      : [];

    if (requestedDraftIds.length === 0) {
      return NextResponse.json({ error: "Choose at least 1 stop." }, { status: 400 });
    }
    if (requestedDraftIds.length > INSTAGRAM_COLLECTION_MAX_STOPS) {
      return NextResponse.json(
        { error: `Select at most ${INSTAGRAM_COLLECTION_MAX_STOPS} stops.` },
        { status: 400 }
      );
    }

    const normalizedDraftIds = normalizeInstagramCollectionDraftIds(
      requestedDraftIds,
      INSTAGRAM_COLLECTION_MAX_STOPS
    );
    if (normalizedDraftIds.length !== requestedDraftIds.length) {
      return NextResponse.json(
        { error: "Duplicate or invalid Instagram drafts were provided." },
        { status: 400 }
      );
    }

    const routeTitle = toNullableTrimmed(body.routeTitle);
    if (!routeTitle) {
      return NextResponse.json(
        { error: "Enter a route title before master publish." },
        { status: 400 }
      );
    }
    const existingRouteId = toNullableTrimmed(body.existingRouteId);

    const admin = getSupabaseAdminClient();
    const drafts = await Promise.all(
      normalizedDraftIds.map((draftId) => getInstagramDraftResponseById(draftId, admin))
    );

    const sharedPublishedJamId = drafts[0]?.publish.publishedJamId ?? null;
    const sharedPublishedRouteId = drafts[0]?.publish.publishedRouteId ?? null;
    const allAlreadyPublished =
      Boolean(sharedPublishedJamId && sharedPublishedRouteId) &&
      drafts.every(
        (draft) =>
          draft.publish.publishedJamId === sharedPublishedJamId &&
          draft.publish.publishedRouteId === sharedPublishedRouteId
      );
    if (allAlreadyPublished && !existingRouteId) {
      return NextResponse.json({
        draftId: normalizedDraftIds[0],
        publishedJamId: sharedPublishedJamId,
        publishedRouteId: sharedPublishedRouteId,
        alreadyPublished: true,
        jobId: null,
      });
    }

    const invalidPublishedDraft = drafts.find((draft) => {
      const publishedRouteId = draft.publish.publishedRouteId;
      const publishedJamId = draft.publish.publishedJamId;
      if (!publishedRouteId && !publishedJamId) return false;
      if (!existingRouteId) return true;
      return publishedRouteId !== existingRouteId;
    });
    if (invalidPublishedDraft) {
      return NextResponse.json(
        {
          error: existingRouteId
            ? "Only stops already published to this Instagram journey can be reused when appending."
            : "Remove already-published stops from the collection before master publish.",
        },
        { status: 400 }
      );
    }

    if (!canMasterPublishInstagramDrafts(drafts, INSTAGRAM_COLLECTION_MAX_STOPS)) {
      return NextResponse.json(
        { error: "Every stop must be draft-ready with a confirmed location before master publish." },
        { status: 400 }
      );
    }

    const { data: activeJobs, error: activeJobsErr } = await admin
      .from("instagram_import_jobs")
      .select("id,draft_id,draft_ids,status,message")
      .eq("phase", "publish_collection")
      .in("status", ["queued", "processing"])
      .in("draft_id", normalizedDraftIds);
    if (activeJobsErr) {
      if (activeJobsErr.message.toLowerCase().includes("draft_ids")) {
        return NextResponse.json({ error: getInstagramDraftIdsMigrationError() }, { status: 500 });
      }
      throw new Error(activeJobsErr.message);
    }

    const message = existingRouteId
      ? `Queued for master publish [route:${existingRouteId}]: ${routeTitle}`
      : `Queued for master publish: ${routeTitle}`;

    const existingJob = (activeJobs ?? []).find((job) =>
      sameOrderedIds((job as { draft_ids?: string[] | null }).draft_ids, normalizedDraftIds) &&
      (job.message || "") === message
    ) as { id: string; message?: string | null } | undefined;
    if (existingJob?.id) {
      return NextResponse.json({ draftId: normalizedDraftIds[0], jobId: existingJob.id, queued: true });
    }
    const job = await createInstagramImportJob(
      normalizedDraftIds[0],
      "publish_collection",
      admin,
      {
        draftIds: normalizedDraftIds,
        message,
      }
    );

    after(async () => {
      try {
        await processQueuedInstagramImportJobs(1);
      } catch (error) {
        console.error("instagram collection publish worker nudge failed", error);
      }
    });

    return NextResponse.json({ draftId: normalizedDraftIds[0], jobId: job.id, queued: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to queue Instagram collection publish" },
      { status: 500 }
    );
  }
}
