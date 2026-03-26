import { toNullableTrimmed } from "@/lib/instagramImport";
import type {
  ComposerStop,
  GooglePlaceComposerCandidate,
  GooglePlaceDraft,
  GooglePlaceDraftStatus,
} from "@/lib/socialComposer";

export type MixedComposerSessionProvider = "instagram" | "tiktok" | "google_places";

export type MixedComposerSessionActiveImportJob = {
  provider: "instagram" | "tiktok";
  draftId: string;
  jobId: string;
};

export type MixedComposerSessionDraftStatus = "draft" | "publishing";

export type MixedComposerSessionSnapshot = {
  activeProvider: MixedComposerSessionProvider;
  routeTitle: string | null;
  customNarratorGuidance: string | null;
  stops: ComposerStop[];
  instagramDraftId: string | null;
  instagramDraftIds: string[];
  tiktokDraftId: string | null;
  activeImportJob: MixedComposerSessionActiveImportJob | null;
  googlePlaceDraft: GooglePlaceDraft | null;
};

export type MixedComposerSessionResponse = MixedComposerSessionSnapshot & {
  id: string;
  jamId: string | null;
  baseRouteId: string | null;
  draftStatus: MixedComposerSessionDraftStatus;
  createdAt: string;
  updatedAt: string;
};

type MixedComposerSessionRow = {
  id: string;
  jam_id: string | null;
  base_route_id: string | null;
  draft_status: string | null;
  active_provider: string | null;
  route_title: string | null;
  custom_narrator_guidance: string | null;
  stops: unknown;
  instagram_draft_id: string | null;
  instagram_draft_ids: unknown;
  tiktok_draft_id: string | null;
  active_import_job: unknown;
  google_place_draft: unknown;
  created_at: string;
  updated_at: string;
};

const SESSION_PROVIDERS = new Set<MixedComposerSessionProvider>([
  "instagram",
  "tiktok",
  "google_places",
]);

const STOP_PROVIDERS = new Set<ComposerStop["provider"]>([
  "instagram",
  "tiktok",
  "google_places",
]);

const STOP_KINDS = new Set<ComposerStop["kind"]>(["social_import", "place_search"]);
const GOOGLE_PLACE_DRAFT_STATUSES = new Set<GooglePlaceDraftStatus>([
  "generating_script",
  "ready",
  "failed",
]);
const SESSION_DRAFT_STATUSES = new Set<MixedComposerSessionDraftStatus>([
  "draft",
  "publishing",
]);

function normalizeSessionProvider(value: unknown): MixedComposerSessionProvider {
  return typeof value === "string" && SESSION_PROVIDERS.has(value as MixedComposerSessionProvider)
    ? (value as MixedComposerSessionProvider)
    : "instagram";
}

function normalizeDraftStatus(value: unknown): MixedComposerSessionDraftStatus {
  return typeof value === "string" && SESSION_DRAFT_STATUSES.has(value as MixedComposerSessionDraftStatus)
    ? (value as MixedComposerSessionDraftStatus)
    : "draft";
}

function normalizeComposerStop(value: unknown): ComposerStop | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = toNullableTrimmed(typeof candidate.id === "string" ? candidate.id : null);
  const kind =
    typeof candidate.kind === "string" && STOP_KINDS.has(candidate.kind as ComposerStop["kind"])
      ? (candidate.kind as ComposerStop["kind"])
      : null;
  const provider =
    typeof candidate.provider === "string" &&
    STOP_PROVIDERS.has(candidate.provider as ComposerStop["provider"])
      ? (candidate.provider as ComposerStop["provider"])
      : null;
  const title = toNullableTrimmed(typeof candidate.title === "string" ? candidate.title : null);
  const image = toNullableTrimmed(typeof candidate.image === "string" ? candidate.image : null);
  const lat = typeof candidate.lat === "number" ? candidate.lat : Number(candidate.lat);
  const lng = typeof candidate.lng === "number" ? candidate.lng : Number(candidate.lng);

  if (!id || !kind || !provider || !title || !image || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    id,
    kind,
    provider,
    title,
    lat,
    lng,
    image,
    googlePlaceId: toNullableTrimmed(
      typeof candidate.googlePlaceId === "string" ? candidate.googlePlaceId : null
    ),
    sourceUrl: toNullableTrimmed(typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : null),
    sourceId: toNullableTrimmed(typeof candidate.sourceId === "string" ? candidate.sourceId : null),
    sourcePreviewImageUrl: toNullableTrimmed(
      typeof candidate.sourcePreviewImageUrl === "string" ? candidate.sourcePreviewImageUrl : null
    ),
    creatorName: toNullableTrimmed(
      typeof candidate.creatorName === "string" ? candidate.creatorName : null
    ),
    creatorUrl: toNullableTrimmed(typeof candidate.creatorUrl === "string" ? candidate.creatorUrl : null),
    creatorAvatarUrl: toNullableTrimmed(
      typeof candidate.creatorAvatarUrl === "string" ? candidate.creatorAvatarUrl : null
    ),
    script: toNullableTrimmed(typeof candidate.script === "string" ? candidate.script : null),
    originalDraftId: toNullableTrimmed(
      typeof candidate.originalDraftId === "string" ? candidate.originalDraftId : null
    ),
    scriptEditedByUser:
      typeof candidate.scriptEditedByUser === "boolean" ? candidate.scriptEditedByUser : null,
    generatedNarratorSignature: toNullableTrimmed(
      typeof candidate.generatedNarratorSignature === "string"
        ? candidate.generatedNarratorSignature
        : null
    ),
    generatedRouteSignature: toNullableTrimmed(
      typeof candidate.generatedRouteSignature === "string"
        ? candidate.generatedRouteSignature
        : null
    ),
  };
}

export function normalizeComposerStops(value: unknown) {
  if (!Array.isArray(value)) return [] as ComposerStop[];
  return value
    .map((candidate) => normalizeComposerStop(candidate))
    .filter((candidate): candidate is ComposerStop => Boolean(candidate));
}

function normalizeInstagramDraftIds(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of value) {
    const draftId = toNullableTrimmed(typeof candidate === "string" ? candidate : null);
    if (!draftId || seen.has(draftId)) continue;
    seen.add(draftId);
    normalized.push(draftId);
  }
  return normalized;
}

export function normalizeActiveImportJob(value: unknown): MixedComposerSessionActiveImportJob | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const provider =
    typeof candidate.provider === "string" && (candidate.provider === "instagram" || candidate.provider === "tiktok")
      ? candidate.provider
      : null;
  const draftId = toNullableTrimmed(typeof candidate.draftId === "string" ? candidate.draftId : null);
  const jobId = toNullableTrimmed(typeof candidate.jobId === "string" ? candidate.jobId : null);
  if (!provider || !draftId || !jobId) return null;
  return {
    provider,
    draftId,
    jobId,
  };
}

function normalizeGooglePlaceCandidate(
  value: unknown
): GooglePlaceComposerCandidate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = toNullableTrimmed(typeof candidate.id === "string" ? candidate.id : null);
  const title = toNullableTrimmed(typeof candidate.title === "string" ? candidate.title : null);
  const image = toNullableTrimmed(typeof candidate.image === "string" ? candidate.image : null);
  const lat = typeof candidate.lat === "number" ? candidate.lat : Number(candidate.lat);
  const lng = typeof candidate.lng === "number" ? candidate.lng : Number(candidate.lng);
  if (!id || !title || !image || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id,
    title,
    lat,
    lng,
    image,
    googlePlaceId: toNullableTrimmed(
      typeof candidate.googlePlaceId === "string" ? candidate.googlePlaceId : null
    ),
  };
}

export function normalizeGooglePlaceDraft(value: unknown): GooglePlaceDraft | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const place = normalizeGooglePlaceCandidate(candidate.place);
  const status =
    typeof candidate.status === "string" &&
    GOOGLE_PLACE_DRAFT_STATUSES.has(candidate.status as GooglePlaceDraftStatus)
      ? (candidate.status as GooglePlaceDraftStatus)
      : null;
  const title = toNullableTrimmed(typeof candidate.title === "string" ? candidate.title : null);
  if (!place || !status || !title) return null;
  return {
    place,
    title,
    script: toNullableTrimmed(typeof candidate.script === "string" ? candidate.script : null),
    status,
    error: toNullableTrimmed(typeof candidate.error === "string" ? candidate.error : null),
    scriptEditedByUser: Boolean(candidate.scriptEditedByUser),
    generatedNarratorSignature: toNullableTrimmed(
      typeof candidate.generatedNarratorSignature === "string"
        ? candidate.generatedNarratorSignature
        : null
    ),
    generatedRouteSignature: toNullableTrimmed(
      typeof candidate.generatedRouteSignature === "string"
        ? candidate.generatedRouteSignature
        : null
    ),
  };
}

export function normalizeMixedComposerSessionSnapshot(
  value: Partial<MixedComposerSessionSnapshot> | null | undefined
): MixedComposerSessionSnapshot {
  return {
    activeProvider: normalizeSessionProvider(value?.activeProvider),
    routeTitle: toNullableTrimmed(value?.routeTitle),
    customNarratorGuidance: toNullableTrimmed(value?.customNarratorGuidance),
    stops: normalizeComposerStops(value?.stops),
    instagramDraftId: toNullableTrimmed(value?.instagramDraftId),
    instagramDraftIds: normalizeInstagramDraftIds(value?.instagramDraftIds),
    tiktokDraftId: toNullableTrimmed(value?.tiktokDraftId),
    activeImportJob: normalizeActiveImportJob(value?.activeImportJob),
    googlePlaceDraft: normalizeGooglePlaceDraft(value?.googlePlaceDraft),
  };
}

export function serializeMixedComposerSession(row: MixedComposerSessionRow): MixedComposerSessionResponse {
  return {
    id: row.id,
    jamId: toNullableTrimmed(row.jam_id),
    baseRouteId: toNullableTrimmed(row.base_route_id),
    draftStatus: normalizeDraftStatus(row.draft_status),
    activeProvider: normalizeSessionProvider(row.active_provider),
    routeTitle: toNullableTrimmed(row.route_title),
    customNarratorGuidance: toNullableTrimmed(row.custom_narrator_guidance),
    stops: normalizeComposerStops(row.stops),
    instagramDraftId: toNullableTrimmed(row.instagram_draft_id),
    instagramDraftIds: normalizeInstagramDraftIds(row.instagram_draft_ids),
    tiktokDraftId: toNullableTrimmed(row.tiktok_draft_id),
    activeImportJob: normalizeActiveImportJob(row.active_import_job),
    googlePlaceDraft: normalizeGooglePlaceDraft(row.google_place_draft),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMixedComposerSessionInsert(snapshot: Partial<MixedComposerSessionSnapshot> | null | undefined) {
  const normalized = normalizeMixedComposerSessionSnapshot(snapshot);
  return {
    active_provider: normalized.activeProvider,
    route_title: normalized.routeTitle,
    custom_narrator_guidance: normalized.customNarratorGuidance,
    stops: normalized.stops,
    instagram_draft_id: normalized.instagramDraftId,
    instagram_draft_ids: normalized.instagramDraftIds,
    tiktok_draft_id: normalized.tiktokDraftId,
    active_import_job: normalized.activeImportJob,
    google_place_draft: normalized.googlePlaceDraft,
  };
}

export function toMixedComposerSessionPatch(snapshot: Partial<MixedComposerSessionSnapshot> | null | undefined) {
  if (!snapshot || typeof snapshot !== "object") return {} as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if ("activeProvider" in snapshot) {
    patch.active_provider = normalizeSessionProvider(snapshot.activeProvider);
  }
  if ("routeTitle" in snapshot) {
    patch.route_title = toNullableTrimmed(snapshot.routeTitle);
  }
  if ("customNarratorGuidance" in snapshot) {
    patch.custom_narrator_guidance = toNullableTrimmed(snapshot.customNarratorGuidance);
  }
  if ("stops" in snapshot) {
    patch.stops = normalizeComposerStops(snapshot.stops);
  }
  if ("instagramDraftId" in snapshot) {
    patch.instagram_draft_id = toNullableTrimmed(snapshot.instagramDraftId);
  }
  if ("instagramDraftIds" in snapshot) {
    patch.instagram_draft_ids = normalizeInstagramDraftIds(snapshot.instagramDraftIds);
  }
  if ("tiktokDraftId" in snapshot) {
    patch.tiktok_draft_id = toNullableTrimmed(snapshot.tiktokDraftId);
  }
  if ("activeImportJob" in snapshot) {
    patch.active_import_job = normalizeActiveImportJob(snapshot.activeImportJob);
  }
  if ("googlePlaceDraft" in snapshot) {
    patch.google_place_draft = normalizeGooglePlaceDraft(snapshot.googlePlaceDraft);
  }

  return patch;
}
