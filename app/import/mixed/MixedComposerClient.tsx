"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CUSTOM_NARRATOR_MAX_CHARS } from "@/lib/customNarrator";
import {
  type InstagramDraftResponse,
  type InstagramPlaceCandidate,
  toNullableTrimmed,
} from "@/lib/instagramImport";
import {
  type TikTokDraftResponse,
  type TikTokImportJobResponse,
} from "@/lib/tiktokImport";
import {
  normalizeMixedComposerSessionSnapshot,
  type MixedComposerSessionResponse,
  type MixedComposerSessionSnapshot,
  type MixedComposerSessionProvider,
} from "@/lib/mixedComposerSession";
import {
  deriveComposerRouteAttribution,
  createGooglePlaceDraft,
  createGooglePlaceNarratorSignature,
  createGooglePlaceRouteSignature,
  isGooglePlaceStopScriptStale,
  mapComposerStopToGooglePlaceDraft,
  mapGooglePlaceDraftOntoComposerStop,
  mapGooglePlaceDraftToComposerStop,
  mapSocialDraftToComposerStop,
  moveComposerStop,
  resolveGooglePlaceDraftPersona,
  type ComposerStop,
  type GooglePlaceDraft,
} from "@/lib/socialComposer";
import styles from "./MixedComposerClient.module.css";

type Provider = "instagram" | "tiktok";
type StopEntryMode = Provider | "google_places";
type Persona = "adult" | "custom";

type SearchPlaceResponse = {
  candidates: Array<{
    id: string;
    title: string;
    lat: number;
    lng: number;
    image: string;
    googlePlaceId?: string;
  }>;
};

type CreateMixResponse = {
  jamId?: string;
  routeId?: string;
  jobId?: string;
  error?: string;
};

type GooglePlaceScriptResponse = {
  script?: string;
  persona?: Persona;
  error?: string;
};

type GooglePlaceCandidate = SearchPlaceResponse["candidates"][number];
type ModalMode =
  | "closed"
  | "import_status"
  | "instagram_editor"
  | "tiktok_editor"
  | "google_place_editor"
  | "edit_instagram";

type ImportJobState = {
  provider: Provider;
  draftId: string;
  jobId: string;
  progress: number;
  message: string;
  error: string | null;
};

const STORAGE_KEY = "mixed-composer:v1";
const MIX_ROUTE_CITY = "nearby";
const CUSTOM_NARRATOR_HELP_TEXT =
  "You can personalize the tone, topic, or perspective. If you skip this, your narrator with be focused on history.";
const CUSTOM_NARRATOR_PLACEHOLDER = "Describe your narrator...";

function buildMixedComposerPath(sessionId?: string | null) {
  const normalizedSessionId = toNullableTrimmed(sessionId);
  if (!normalizedSessionId) return "/import/mixed";
  const params = new URLSearchParams();
  params.set("session", normalizedSessionId);
  return `/import/mixed?${params.toString()}`;
}

function preferredInstagramPlaceQuery(draft: InstagramDraftResponse | null) {
  return (
    draft?.location.confirmedPlace?.label ||
    draft?.location.suggestedPlace?.label ||
    draft?.location.placeQuery ||
    ""
  );
}

function preferredTikTokPlaceQuery(draft: TikTokDraftResponse | null) {
  return (
    draft?.location.confirmedPlace?.label ||
    draft?.location.suggestedPlace?.label ||
    draft?.location.placeQuery ||
    ""
  );
}

function formatTokenEstimate(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "Pending";
  return `~${value} tokens`;
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeStops(stops: ComposerStop[]) {
  const seen = new Set<string>();
  return stops.filter((stop) => {
    const key = stop.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readStoredStops() {
  if (typeof window === "undefined") return [] as ComposerStop[];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [] as ComposerStop[];
    const parsed = JSON.parse(raw) as ComposerStop[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as ComposerStop[];
  }
}

export default function MixedComposerClient({
  initialSessionId,
  initialProvider,
  initialInstagramDraftId,
  initialTikTokDraftId,
}: {
  initialSessionId: string | null;
  initialProvider: string | null;
  initialInstagramDraftId: string | null;
  initialTikTokDraftId: string | null;
}) {
  const router = useRouter();
  const [stopEntryMode, setStopEntryMode] = useState<StopEntryMode>(
    initialProvider === "tiktok" ? "tiktok" : "instagram"
  );
  const [customNarratorGuidance, setCustomNarratorGuidance] = useState("");
  const [routeTitle, setRouteTitle] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [googleSearchQuery, setGoogleSearchQuery] = useState("");
  const [googleSearchResults, setGoogleSearchResults] = useState<GooglePlaceCandidate[]>([]);
  const [isSearchingGooglePlaces, setIsSearchingGooglePlaces] = useState(false);
  const [instagramDraft, setInstagramDraft] = useState<InstagramDraftResponse | null>(null);
  const [instagramDraftIds, setInstagramDraftIds] = useState<string[]>([]);
  const [instagramDraftsById, setInstagramDraftsById] = useState<Record<string, InstagramDraftResponse>>({});
  const [instagramSelectedDraftIds, setInstagramSelectedDraftIds] = useState<string[]>([]);
  const [instagramTitleInput, setInstagramTitleInput] = useState("");
  const [instagramScriptInput, setInstagramScriptInput] = useState("");
  const [instagramPlaceQueryInput, setInstagramPlaceQueryInput] = useState("");
  const [instagramPlaceResults, setInstagramPlaceResults] = useState<InstagramPlaceCandidate[]>([]);
  const [instagramSearchError, setInstagramSearchError] = useState<string | null>(null);
  const [isSavingInstagramDraft, setIsSavingInstagramDraft] = useState(false);
  const [isSearchingInstagramPlaces, setIsSearchingInstagramPlaces] = useState(false);
  const [tiktokDraft, setTikTokDraft] = useState<TikTokDraftResponse | null>(null);
  const [tiktokTitleInput, setTikTokTitleInput] = useState("");
  const [tiktokScriptInput, setTikTokScriptInput] = useState("");
  const [tiktokPlaceQueryInput, setTikTokPlaceQueryInput] = useState("");
  const [tiktokPlaceResults, setTikTokPlaceResults] = useState<InstagramPlaceCandidate[]>([]);
  const [tiktokSearchError, setTikTokSearchError] = useState<string | null>(null);
  const [isSavingTikTokDraft, setIsSavingTikTokDraft] = useState(false);
  const [isSearchingTikTokPlaces, setIsSearchingTikTokPlaces] = useState(false);
  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const [editingGooglePlaceStopId, setEditingGooglePlaceStopId] = useState<string | null>(null);
  const [editingInstagramDraft, setEditingInstagramDraft] = useState<InstagramDraftResponse | null>(null);
  const [editingInstagramTitleInput, setEditingInstagramTitleInput] = useState("");
  const [editingInstagramScriptInput, setEditingInstagramScriptInput] = useState("");
  const [editingInstagramPlaceQueryInput, setEditingInstagramPlaceQueryInput] = useState("");
  const [editingInstagramPlaceResults, setEditingInstagramPlaceResults] = useState<InstagramPlaceCandidate[]>([]);
  const [editingInstagramSearchError, setEditingInstagramSearchError] = useState<string | null>(null);
  const [isSavingEditingInstagramDraft, setIsSavingEditingInstagramDraft] = useState(false);
  const [isSearchingEditingInstagramPlaces, setIsSearchingEditingInstagramPlaces] = useState(false);
  const [stops, setStops] = useState<ComposerStop[]>([]);
  const [modalMode, setModalMode] = useState<ModalMode>("closed");
  const [importJobState, setImportJobState] = useState<ImportJobState | null>(null);
  const [googlePlaceDraft, setGooglePlaceDraft] = useState<GooglePlaceDraft | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [isInitialStateReady, setIsInitialStateReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSavingGooglePlaceDraft, setIsSavingGooglePlaceDraft] = useState(false);
  const creatingSessionPromiseRef = useRef<Promise<string> | null>(null);
  const lastSavedSessionSnapshotRef = useRef<string | null>(null);
  const googlePlaceGenerationRequestRef = useRef(0);
  const attribution = useMemo(() => deriveComposerRouteAttribution(stops), [stops]);
  const narratorSignature = useMemo(
    () => createGooglePlaceNarratorSignature(customNarratorGuidance),
    [customNarratorGuidance]
  );
  const draftRouteSignature = useMemo(
    () => createGooglePlaceRouteSignature(stops.length, stops.length + 1),
    [stops.length]
  );
  const activeSocialProvider: Provider = stopEntryMode === "tiktok" ? "tiktok" : "instagram";
  const instagramConfirmedPlace = instagramDraft?.location.confirmedPlace || null;
  const instagramSuggestedPlace = instagramDraft?.location.suggestedPlace || null;
  const tiktokConfirmedPlace = tiktokDraft?.location.confirmedPlace || null;
  const tiktokSuggestedPlace = tiktokDraft?.location.suggestedPlace || null;
  const editingInstagramConfirmedPlace = editingInstagramDraft?.location.confirmedPlace || null;
  const editingInstagramSuggestedPlace = editingInstagramDraft?.location.suggestedPlace || null;

  useEffect(() => {
    let cancelled = false;

    async function initializeComposer() {
      if (initialSessionId) {
        try {
          const restored = await fetchJson<MixedComposerSessionResponse>(
            `/api/mixed-composer-sessions/${encodeURIComponent(initialSessionId)}`
          );
          if (cancelled) return;

          const snapshot = normalizeMixedComposerSessionSnapshot(restored);
          setSessionId(restored.id);
          setStopEntryMode(snapshot.activeProvider);
          setRouteTitle(snapshot.routeTitle || "");
          setCustomNarratorGuidance(snapshot.customNarratorGuidance || "");
          setStops(snapshot.stops);
          setInstagramDraft(null);
          setInstagramDraftIds(snapshot.instagramDraftIds);
          setTikTokDraft(null);
          setGooglePlaceDraft(null);
          setImportJobState(null);
          setModalMode("closed");
          setError(null);
          lastSavedSessionSnapshotRef.current = JSON.stringify(snapshot);

          if (snapshot.activeImportJob) {
            setImportJobState({
              ...snapshot.activeImportJob,
              progress: 0,
              message: "Queued",
              error: null,
            });
            setModalMode("import_status");
          } else if (
            (snapshot.instagramDraftId || snapshot.instagramDraftIds.length > 0) &&
            (!snapshot.tiktokDraftId || snapshot.activeProvider === "instagram")
          ) {
            setStopEntryMode("instagram");
            setModalMode("instagram_editor");
            const draftIds =
              snapshot.instagramDraftIds.length > 0
                ? snapshot.instagramDraftIds
                : [snapshot.instagramDraftId].filter(
                    (draftId): draftId is string => Boolean(toNullableTrimmed(draftId))
                  );
            const drafts = await Promise.all(
              draftIds.map((draftId) => loadInstagramDraftWithRetry(draftId))
            );
            if (cancelled) return;
            setInstagramDraftsById(
              Object.fromEntries(drafts.map((draft) => [draft.id, draft]))
            );
            setInstagramSelectedDraftIds(draftIds);
            setInstagramDraftIds(draftIds);
            const draft =
              drafts.find((candidate) => candidate.id === snapshot.instagramDraftId) ??
              drafts[0] ??
              null;
            if (!draft) {
              throw new Error("Failed to restore Instagram drafts");
            }
            setInstagramDraft(draft);
          } else if (snapshot.tiktokDraftId) {
            setStopEntryMode("tiktok");
            setModalMode("tiktok_editor");
            const draft = await loadTikTokDraftWithRetry(snapshot.tiktokDraftId);
            if (cancelled) return;
            setTikTokDraft(draft);
          } else if (snapshot.googlePlaceDraft) {
            setStopEntryMode("google_places");
            setGooglePlaceDraft(snapshot.googlePlaceDraft);
            setModalMode("google_place_editor");
          }
        } catch (restoreError) {
          if (!cancelled) {
            setError(
              restoreError instanceof Error
                ? restoreError.message
                : "Failed to restore mixed composer session"
            );
          }
        } finally {
          if (!cancelled) {
            setIsInitialStateReady(true);
          }
        }
        return;
      }

      setStops(readStoredStops());

      if (initialInstagramDraftId) {
        try {
          const draft = await fetchJson<InstagramDraftResponse>(
            `/api/instagram-imports/drafts/${encodeURIComponent(initialInstagramDraftId)}`
          );
          if (!cancelled) {
            setInstagramDraftIds([draft.id]);
            setInstagramDraftsById({ [draft.id]: draft });
            setInstagramSelectedDraftIds([draft.id]);
            setInstagramDraft(draft);
            setStopEntryMode("instagram");
            setModalMode("instagram_editor");
          }
        } catch {
          // ignore preload failures
        }
      } else if (initialTikTokDraftId) {
        try {
          const draft = await fetchJson<TikTokDraftResponse>(
            `/api/tiktok-imports/drafts/${encodeURIComponent(initialTikTokDraftId)}`
          );
          if (!cancelled) {
            setTikTokDraft(draft);
            setStopEntryMode("tiktok");
            setModalMode("tiktok_editor");
          }
        } catch {
          // ignore preload failures
        }
      }

      if (!cancelled) {
        setIsInitialStateReady(true);
      }
    }

    void initializeComposer();

    return () => {
      cancelled = true;
    };
  }, [initialInstagramDraftId, initialSessionId, initialTikTokDraftId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionId) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stops));
  }, [sessionId, stops]);

  useEffect(() => {
    if (!instagramDraft) {
      setInstagramTitleInput("");
      setInstagramScriptInput("");
      setInstagramPlaceQueryInput("");
      setInstagramPlaceResults([]);
      setInstagramSearchError(null);
      return;
    }
    setInstagramDraftsById((current) => ({
      ...current,
      [instagramDraft.id]: instagramDraft,
    }));
    setInstagramTitleInput(instagramDraft.content.editedTitle || instagramDraft.content.generatedTitle || "");
    setInstagramScriptInput(instagramDraft.content.editedScript || instagramDraft.content.generatedScript || "");
    setInstagramPlaceQueryInput(preferredInstagramPlaceQuery(instagramDraft));
    setInstagramPlaceResults(instagramDraft.location.suggestedPlace ? [instagramDraft.location.suggestedPlace] : []);
    setInstagramSearchError(null);
  }, [instagramDraft]);

  useEffect(() => {
    if (!tiktokDraft) {
      setTikTokTitleInput("");
      setTikTokScriptInput("");
      setTikTokPlaceQueryInput("");
      setTikTokPlaceResults([]);
      setTikTokSearchError(null);
      return;
    }
    setTikTokTitleInput(tiktokDraft.content.editedTitle || tiktokDraft.content.generatedTitle || "");
    setTikTokScriptInput(tiktokDraft.content.editedScript || tiktokDraft.content.generatedScript || "");
    setTikTokPlaceQueryInput(preferredTikTokPlaceQuery(tiktokDraft));
    setTikTokPlaceResults(tiktokDraft.location.suggestedPlace ? [tiktokDraft.location.suggestedPlace] : []);
    setTikTokSearchError(null);
  }, [tiktokDraft]);

  useEffect(() => {
    if (!editingInstagramDraft) {
      setEditingInstagramTitleInput("");
      setEditingInstagramScriptInput("");
      setEditingInstagramPlaceQueryInput("");
      setEditingInstagramPlaceResults([]);
      setEditingInstagramSearchError(null);
      return;
    }
    setEditingInstagramTitleInput(
      editingInstagramDraft.content.editedTitle || editingInstagramDraft.content.generatedTitle || ""
    );
    setEditingInstagramScriptInput(
      editingInstagramDraft.content.editedScript || editingInstagramDraft.content.generatedScript || ""
    );
    setEditingInstagramPlaceQueryInput(preferredInstagramPlaceQuery(editingInstagramDraft));
    setEditingInstagramPlaceResults(
      editingInstagramDraft.location.suggestedPlace ? [editingInstagramDraft.location.suggestedPlace] : []
    );
    setEditingInstagramSearchError(null);
  }, [editingInstagramDraft]);

  useEffect(() => {
    if (modalMode !== "import_status" || !importJobState) return;

    const activeJob = importJobState;
    let cancelled = false;

    async function pollImportJob() {
      while (!cancelled) {
        try {
          const job = await fetchJson<(TikTokImportJobResponse & { draftIds?: string[] | null })>(
            `/api/${activeJob.provider}-imports/jobs/${encodeURIComponent(activeJob.jobId)}`
          );
          if (cancelled) return;
          const isDraftReady =
            job.status === "draft_ready" ||
            (job.progress >= 100 && /draft ready/i.test(job.message || ""));

          setImportJobState((current) =>
            current && current.jobId === activeJob.jobId
              ? {
                  ...current,
                  progress: job.progress,
                  message: job.message,
                  error: job.error,
                }
              : current
          );

          if (isDraftReady) {
            const resolvedDraftIds =
              activeJob.provider === "instagram"
                ? Array.from(
                    new Set(
                      (job.draftIds && job.draftIds.length > 0 ? job.draftIds : [job.draftId || activeJob.draftId])
                        .map((draftId) => toNullableTrimmed(draftId))
                        .filter((draftId): draftId is string => Boolean(draftId))
                    )
                  )
                : [job.draftId || activeJob.draftId].filter(
                    (draftId): draftId is string => Boolean(toNullableTrimmed(draftId))
                  );
            if (cancelled) return;
            finalizeImportedDraft(activeJob.provider, resolvedDraftIds);
            return;
          }

          if (job.status === "failed") {
            setImportJobState((current) =>
              current && current.jobId === activeJob.jobId
                ? {
                    ...current,
                    progress: job.progress,
                    message: job.message,
                    error: job.error || `Failed to import ${activeJob.provider} draft`,
                  }
                : current
            );
            return;
          }
        } catch (pollError) {
          if (cancelled) return;
          setImportJobState((current) =>
            current && current.jobId === activeJob.jobId
              ? {
                  ...current,
                  error:
                    pollError instanceof Error
                      ? pollError.message
                      : `Failed to load ${activeJob.provider} import status`,
                }
              : current
          );
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }

    void pollImportJob();

    return () => {
      cancelled = true;
    };
  }, [modalMode, importJobState]);

  function clearInstagramDraftEditor() {
    setInstagramDraft(null);
    setInstagramDraftIds([]);
    setInstagramDraftsById({});
    setInstagramSelectedDraftIds([]);
    setInstagramSearchError(null);
    setImportUrl("");
  }

  function clearTikTokDraftEditor() {
    setTikTokDraft(null);
    setTikTokSearchError(null);
    setImportUrl("");
  }

  function clearGooglePlaceDraftEditor() {
    googlePlaceGenerationRequestRef.current += 1;
    setGooglePlaceDraft(null);
    void persistMixedComposerSession({ googlePlaceDraft: null }, { createIfMissing: true });
  }

  function closeEditingGooglePlaceModal() {
    googlePlaceGenerationRequestRef.current += 1;
    setEditingGooglePlaceStopId(null);
    setGooglePlaceDraft(null);
  }

  function closeEditingInstagramModal() {
    setEditingStopId(null);
    setEditingInstagramDraft(null);
    setEditingInstagramSearchError(null);
  }

  function closeActiveModal() {
    if (modalMode === "instagram_editor") {
      clearInstagramDraftEditor();
    } else if (modalMode === "tiktok_editor") {
      clearTikTokDraftEditor();
    } else if (modalMode === "edit_instagram") {
      closeEditingInstagramModal();
    } else if (modalMode === "google_place_editor") {
      if (editingGooglePlaceStopId) {
        closeEditingGooglePlaceModal();
      } else {
        clearGooglePlaceDraftEditor();
      }
    }

    setImportJobState(null);
    setModalMode("closed");
  }

  async function patchInstagramDraft(body: {
    editedTitle?: string | null;
    editedScript?: string | null;
    placeQuery?: string | null;
    confirmedPlace?:
      | {
          label: string;
          lat: number;
          lng: number;
          imageUrl?: string | null;
          googlePlaceId?: string | null;
        }
      | null;
  }) {
    if (!instagramDraft) return null;
    const updated = await fetchJson<InstagramDraftResponse>(
      `/api/instagram-imports/drafts/${encodeURIComponent(instagramDraft.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    setInstagramDraft(updated);
    setInstagramDraftsById((current) => ({
      ...current,
      [updated.id]: updated,
    }));
    return updated;
  }

  async function loadInstagramDraftWithRetry(draftId: string, attempts = 12) {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fetchJson<InstagramDraftResponse>(
          `/api/instagram-imports/drafts/${encodeURIComponent(draftId)}`
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Failed to load Instagram draft");
        if (attempt < attempts - 1) {
          await sleep(500);
        }
      }
    }
    throw lastError || new Error("Failed to load Instagram draft");
  }

  async function loadTikTokDraftWithRetry(draftId: string, attempts = 12) {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fetchJson<TikTokDraftResponse>(
          `/api/tiktok-imports/drafts/${encodeURIComponent(draftId)}`
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Failed to load TikTok draft");
        if (attempt < attempts - 1) {
          await sleep(500);
        }
      }
    }
    throw lastError || new Error("Failed to load TikTok draft");
  }

  async function loadInstagramDraftCollection(draftIds: string[]) {
    const normalizedDraftIds = Array.from(
      new Set(draftIds.map((draftId) => toNullableTrimmed(draftId)).filter((draftId): draftId is string => Boolean(draftId)))
    );
    const drafts = await Promise.all(
      normalizedDraftIds.map((draftId) => loadInstagramDraftWithRetry(draftId))
    );
    const draftsById = Object.fromEntries(drafts.map((draft) => [draft.id, draft]));
    setInstagramDraftIds(normalizedDraftIds);
    setInstagramDraftsById((current) => ({ ...current, ...draftsById }));
    setInstagramSelectedDraftIds(normalizedDraftIds);
    setInstagramDraft(drafts[0] ?? null);
    return drafts;
  }

  const buildSessionSnapshot = useCallback(
    (overrides?: Partial<MixedComposerSessionSnapshot>): MixedComposerSessionSnapshot =>
      normalizeMixedComposerSessionSnapshot({
        activeProvider: (overrides?.activeProvider ?? stopEntryMode) as MixedComposerSessionProvider,
        routeTitle: overrides?.routeTitle ?? routeTitle,
        customNarratorGuidance: overrides?.customNarratorGuidance ?? customNarratorGuidance,
        stops: overrides?.stops ?? stops,
        instagramDraftId: overrides?.instagramDraftId ?? (instagramDraft?.id || null),
        instagramDraftIds: overrides?.instagramDraftIds ?? instagramDraftIds,
        tiktokDraftId: overrides?.tiktokDraftId ?? (tiktokDraft?.id || null),
        activeImportJob:
          overrides?.activeImportJob ??
          (importJobState
            ? {
                provider: importJobState.provider,
                draftId: importJobState.draftId,
                jobId: importJobState.jobId,
              }
            : null),
        googlePlaceDraft:
          overrides?.googlePlaceDraft ??
          (editingGooglePlaceStopId ? null : googlePlaceDraft),
      }),
    [
      customNarratorGuidance,
      editingGooglePlaceStopId,
      googlePlaceDraft,
      importJobState,
      instagramDraft?.id,
      instagramDraftIds,
      routeTitle,
      stopEntryMode,
      stops,
      tiktokDraft?.id,
    ]
  );

  const persistMixedComposerSession = useCallback(
    async (
      overrides?: Partial<MixedComposerSessionSnapshot>,
      options?: { createIfMissing?: boolean }
    ) => {
      const snapshot = buildSessionSnapshot(overrides);
      const nextSnapshotKey = JSON.stringify(snapshot);
      let resolvedSessionId = sessionId;

      if (!resolvedSessionId) {
        if (!options?.createIfMissing) return null;

        if (!creatingSessionPromiseRef.current) {
          creatingSessionPromiseRef.current = (async () => {
            const created = await fetchJson<MixedComposerSessionResponse>(
              "/api/mixed-composer-sessions",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(snapshot),
              }
            );
            const normalizedCreatedSnapshot = normalizeMixedComposerSessionSnapshot(created);
            const createdSnapshotKey = JSON.stringify(normalizedCreatedSnapshot);
            lastSavedSessionSnapshotRef.current = createdSnapshotKey;
            setSessionId(created.id);
            router.replace(buildMixedComposerPath(created.id));
            return created.id;
          })().finally(() => {
            creatingSessionPromiseRef.current = null;
          });
        }

        resolvedSessionId = await creatingSessionPromiseRef.current;
        return resolvedSessionId;
      }

      if (lastSavedSessionSnapshotRef.current === nextSnapshotKey) {
        return resolvedSessionId;
      }

      await fetchJson<MixedComposerSessionResponse>(
        `/api/mixed-composer-sessions/${encodeURIComponent(resolvedSessionId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        }
      );
      lastSavedSessionSnapshotRef.current = nextSnapshotKey;
      return resolvedSessionId;
    },
    [buildSessionSnapshot, router, sessionId]
  );

  const requestGooglePlaceScript = useCallback(
    async (
      stop: {
        id: string;
        title: string;
        lat: number;
        lng: number;
        image: string;
        googlePlaceId?: string | null;
      },
      stopIndex: number,
      totalStops: number
    ) => {
      const response = await fetchJson<GooglePlaceScriptResponse>(
        "/api/google-place-scripts/generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            city: MIX_ROUTE_CITY,
            transportMode: "walk",
            lengthMinutes: 30,
            persona: resolveGooglePlaceDraftPersona(customNarratorGuidance),
            narratorGuidance: toNullableTrimmed(customNarratorGuidance),
            stop,
            stopIndex,
            totalStops,
          }),
        }
      );

      const script = toNullableTrimmed(response.script);
      if (!script) {
        throw new Error(response.error || "Generated script was empty.");
      }
      return script;
    },
    [customNarratorGuidance]
  );

  const generateGooglePlaceDraftScript = useCallback(
    async (
      draft: GooglePlaceDraft,
      nextNarratorSignature: string,
      nextRouteSignature: string,
      options?: {
        stopIndex?: number;
        totalStops?: number;
        persistSession?: boolean;
      }
    ) => {
      const stopIndex = options?.stopIndex ?? stops.length;
      const totalStops = options?.totalStops ?? (stops.length + 1);
      const persistSession = options?.persistSession ?? true;
      const requestId = googlePlaceGenerationRequestRef.current + 1;
      googlePlaceGenerationRequestRef.current = requestId;
      const pendingDraft: GooglePlaceDraft = {
        ...draft,
        status: "generating_script",
        error: null,
        generatedNarratorSignature: nextNarratorSignature,
        generatedRouteSignature: nextRouteSignature,
      };
      setGooglePlaceDraft(pendingDraft);
      if (persistSession) {
        await persistMixedComposerSession(
          {
            activeProvider: "google_places",
            googlePlaceDraft: pendingDraft,
          },
          { createIfMissing: true }
        );
      }

      try {
        const script = await requestGooglePlaceScript(
          pendingDraft.place,
          stopIndex,
          totalStops
        );
        if (googlePlaceGenerationRequestRef.current !== requestId) return;

        const readyDraft: GooglePlaceDraft = {
          ...pendingDraft,
          script,
          status: "ready",
          error: null,
        };
        setGooglePlaceDraft(readyDraft);
        if (persistSession) {
          await persistMixedComposerSession(
            {
              activeProvider: "google_places",
              googlePlaceDraft: readyDraft,
            },
            { createIfMissing: true }
          );
        }
      } catch (generationError) {
        if (googlePlaceGenerationRequestRef.current !== requestId) return;

        const failedDraft: GooglePlaceDraft = {
          ...pendingDraft,
          status: "failed",
          error:
            generationError instanceof Error
              ? generationError.message
              : "Failed to generate Google place script",
        };
        setGooglePlaceDraft(failedDraft);
        if (persistSession) {
          await persistMixedComposerSession(
            {
              activeProvider: "google_places",
              googlePlaceDraft: failedDraft,
            },
            { createIfMissing: true }
          );
        }
      }
    },
    [persistMixedComposerSession, requestGooglePlaceScript, stops.length]
  );

  async function handleSaveGooglePlaceDraft() {
    if (!googlePlaceDraft || editingGooglePlaceStopId) return;
    setIsSavingGooglePlaceDraft(true);
    try {
      await persistMixedComposerSession(
        {
          activeProvider: "google_places",
          googlePlaceDraft,
        },
        { createIfMissing: true }
      );
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save Google place draft");
    } finally {
      setIsSavingGooglePlaceDraft(false);
    }
  }

  async function regenerateStaleGooglePlaceStops(currentStops: ComposerStop[]) {
    const nextNarratorSignature = createGooglePlaceNarratorSignature(customNarratorGuidance);
    const refreshedStops = [...currentStops];
    let didChange = false;

    for (let index = 0; index < refreshedStops.length; index += 1) {
      const stop = refreshedStops[index];
      if (!stop) continue;
      const routeSignature = createGooglePlaceRouteSignature(index, refreshedStops.length);
      if (!isGooglePlaceStopScriptStale(stop, nextNarratorSignature, routeSignature)) continue;

      const script = await requestGooglePlaceScript(stop, index, refreshedStops.length);
      refreshedStops[index] = {
        ...stop,
        script,
        scriptEditedByUser: false,
        generatedNarratorSignature: nextNarratorSignature,
        generatedRouteSignature: routeSignature,
      };
      didChange = true;
    }

    if (!didChange) return currentStops;

    await persistMixedComposerSession(
      {
        stops: refreshedStops,
      },
      { createIfMissing: true }
    );
    setStops(refreshedStops);
    return refreshedStops;
  }

  async function patchTikTokDraft(body: {
    editedTitle?: string | null;
    editedScript?: string | null;
    placeQuery?: string | null;
    confirmedPlace?:
      | {
          label: string;
          lat: number;
          lng: number;
          imageUrl?: string | null;
          googlePlaceId?: string | null;
        }
      | null;
  }) {
    if (!tiktokDraft) return null;
    const updated = await fetchJson<TikTokDraftResponse>(
      `/api/tiktok-imports/drafts/${encodeURIComponent(tiktokDraft.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    setTikTokDraft(updated);
    return updated;
  }

  async function patchEditingInstagramDraft(body: {
    editedTitle?: string | null;
    editedScript?: string | null;
    placeQuery?: string | null;
    confirmedPlace?:
      | {
          label: string;
          lat: number;
          lng: number;
          imageUrl?: string | null;
          googlePlaceId?: string | null;
        }
      | null;
  }) {
    if (!editingInstagramDraft) return null;
    const updated = await fetchJson<InstagramDraftResponse>(
      `/api/instagram-imports/drafts/${encodeURIComponent(editingInstagramDraft.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    setEditingInstagramDraft(updated);
    return updated;
  }

  async function persistInstagramDraftEdits() {
    if (!instagramDraft) return null;

    const nextEditedTitle = toNullableTrimmed(instagramTitleInput);
    const nextEditedScript = toNullableTrimmed(instagramScriptInput);
    const nextPlaceQuery = toNullableTrimmed(instagramPlaceQueryInput);
    const currentEditedTitle = toNullableTrimmed(instagramDraft.content.editedTitle);
    const currentEditedScript = toNullableTrimmed(instagramDraft.content.editedScript);
    const currentPlaceQuery = toNullableTrimmed(instagramDraft.location.placeQuery);

    if (
      nextEditedTitle === currentEditedTitle &&
      nextEditedScript === currentEditedScript &&
      nextPlaceQuery === currentPlaceQuery
    ) {
      return instagramDraft;
    }

    return await patchInstagramDraft({
      editedTitle: instagramTitleInput,
      editedScript: instagramScriptInput,
      placeQuery: instagramPlaceQueryInput,
    });
  }

  async function persistEditingInstagramDraftEdits() {
    if (!editingInstagramDraft) return null;

    const nextEditedTitle = toNullableTrimmed(editingInstagramTitleInput);
    const nextEditedScript = toNullableTrimmed(editingInstagramScriptInput);
    const nextPlaceQuery = toNullableTrimmed(editingInstagramPlaceQueryInput);
    const currentEditedTitle = toNullableTrimmed(editingInstagramDraft.content.editedTitle);
    const currentEditedScript = toNullableTrimmed(editingInstagramDraft.content.editedScript);
    const currentPlaceQuery = toNullableTrimmed(editingInstagramDraft.location.placeQuery);

    if (
      nextEditedTitle === currentEditedTitle &&
      nextEditedScript === currentEditedScript &&
      nextPlaceQuery === currentPlaceQuery
    ) {
      return editingInstagramDraft;
    }

    return await patchEditingInstagramDraft({
      editedTitle: editingInstagramTitleInput,
      editedScript: editingInstagramScriptInput,
      placeQuery: editingInstagramPlaceQueryInput,
    });
  }

  async function persistTikTokDraftEdits() {
    if (!tiktokDraft) return null;

    const nextEditedTitle = toNullableTrimmed(tiktokTitleInput);
    const nextEditedScript = toNullableTrimmed(tiktokScriptInput);
    const nextPlaceQuery = toNullableTrimmed(tiktokPlaceQueryInput);
    const currentEditedTitle = toNullableTrimmed(tiktokDraft.content.editedTitle);
    const currentEditedScript = toNullableTrimmed(tiktokDraft.content.editedScript);
    const currentPlaceQuery = toNullableTrimmed(tiktokDraft.location.placeQuery);

    if (
      nextEditedTitle === currentEditedTitle &&
      nextEditedScript === currentEditedScript &&
      nextPlaceQuery === currentPlaceQuery
    ) {
      return tiktokDraft;
    }

    return await patchTikTokDraft({
      editedTitle: tiktokTitleInput,
      editedScript: tiktokScriptInput,
      placeQuery: tiktokPlaceQueryInput,
    });
  }

  async function importSocialDraft() {
    if (stopEntryMode === "google_places") return;

    const trimmedUrl = importUrl.trim();
    if (!trimmedUrl) {
      setError("Enter an Instagram or TikTok URL.");
      return;
    }

    setError(null);

    try {
      const create = await fetchJson<{ draftId: string; jobId: string }>(
        `/api/${activeSocialProvider}-imports/create`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmedUrl }),
        }
      );
      const nextImportJob: ImportJobState = {
        provider: activeSocialProvider,
        draftId: create.draftId,
        jobId: create.jobId,
        progress: 0,
        message: "Queued",
        error: null,
      };
      setImportJobState(nextImportJob);
      setModalMode("import_status");
      await persistMixedComposerSession(
        {
          activeProvider: activeSocialProvider,
          activeImportJob: {
            provider: nextImportJob.provider,
            draftId: nextImportJob.draftId,
            jobId: nextImportJob.jobId,
          },
        },
        { createIfMissing: true }
      );
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : `Failed to import ${activeSocialProvider} draft`
      );
    }
  }

  async function searchPlaces() {
    const trimmedQuery = googleSearchQuery.trim();
    if (trimmedQuery.length < 2) {
      setError("Enter at least 2 characters to search places.");
      return;
    }
    setError(null);
    setIsSearchingGooglePlaces(true);
    try {
      const body = await fetchJson<SearchPlaceResponse>("/api/stops/search-places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmedQuery, limit: 6 }),
      });
      setGoogleSearchResults(body.candidates);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Failed to search places");
    } finally {
      setIsSearchingGooglePlaces(false);
    }
  }

  async function handleSaveInstagramDraft() {
    if (!instagramDraft) return;
    setIsSavingInstagramDraft(true);
    setError(null);
    try {
      await persistMixedComposerSession(
        {
          activeProvider: "instagram",
          instagramDraftId: instagramDraft.id,
        },
        { createIfMissing: true }
      );
      await patchInstagramDraft({
        editedTitle: instagramTitleInput,
        editedScript: instagramScriptInput,
        placeQuery: instagramPlaceQueryInput,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save draft");
    } finally {
      setIsSavingInstagramDraft(false);
    }
  }

  async function handleSearchInstagramPlaces() {
    if (!instagramDraft) return;
    setIsSearchingInstagramPlaces(true);
    setInstagramSearchError(null);
    try {
      const response = await fetchJson<{ candidates?: InstagramPlaceCandidate[] }>(
        `/api/instagram-imports/drafts/${encodeURIComponent(instagramDraft.id)}/places/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: instagramPlaceQueryInput }),
        }
      );
      const candidates = response.candidates || [];
      setInstagramPlaceResults(candidates);
      if (candidates.length === 0) {
        setInstagramSearchError("No matching places were found.");
      }
    } catch (placeError) {
      setInstagramSearchError(
        placeError instanceof Error ? placeError.message : "Failed to search places"
      );
    } finally {
      setIsSearchingInstagramPlaces(false);
    }
  }

  async function handleSaveTikTokDraft() {
    if (!tiktokDraft) return;
    setIsSavingTikTokDraft(true);
    setError(null);
    try {
      await persistMixedComposerSession(
        {
          activeProvider: "tiktok",
          tiktokDraftId: tiktokDraft.id,
        },
        { createIfMissing: true }
      );
      await patchTikTokDraft({
        editedTitle: tiktokTitleInput,
        editedScript: tiktokScriptInput,
        placeQuery: tiktokPlaceQueryInput,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save draft");
    } finally {
      setIsSavingTikTokDraft(false);
    }
  }

  async function handleSearchTikTokPlaces() {
    if (!tiktokDraft) return;
    setIsSearchingTikTokPlaces(true);
    setTikTokSearchError(null);
    try {
      const response = await fetchJson<{ candidates?: InstagramPlaceCandidate[] }>(
        `/api/tiktok-imports/drafts/${encodeURIComponent(tiktokDraft.id)}/places/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: tiktokPlaceQueryInput }),
        }
      );
      const candidates = response.candidates || [];
      setTikTokPlaceResults(candidates);
      if (candidates.length === 0) {
        setTikTokSearchError("No matching places were found.");
      }
    } catch (placeError) {
      setTikTokSearchError(
        placeError instanceof Error ? placeError.message : "Failed to search places"
      );
    } finally {
      setIsSearchingTikTokPlaces(false);
    }
  }

  async function handleConfirmTikTokPlace(candidate: InstagramPlaceCandidate | null) {
    try {
      await persistMixedComposerSession(
        {
          activeProvider: "tiktok",
          tiktokDraftId: tiktokDraft?.id || null,
        },
        { createIfMissing: true }
      );
      await patchTikTokDraft({
        placeQuery: tiktokPlaceQueryInput,
        confirmedPlace: candidate
          ? {
              label: candidate.label,
              lat: candidate.lat,
              lng: candidate.lng,
              imageUrl: candidate.imageUrl,
              googlePlaceId: candidate.googlePlaceId,
            }
          : null,
      });
      setError(null);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Failed to confirm place");
    }
  }

  async function handleConfirmInstagramPlace(candidate: InstagramPlaceCandidate | null) {
    try {
      await persistMixedComposerSession(
        {
          activeProvider: "instagram",
          instagramDraftId: instagramDraft?.id || null,
        },
        { createIfMissing: true }
      );
      await patchInstagramDraft({
        placeQuery: instagramPlaceQueryInput,
        confirmedPlace: candidate
          ? {
              label: candidate.label,
              lat: candidate.lat,
              lng: candidate.lng,
              imageUrl: candidate.imageUrl,
              googlePlaceId: candidate.googlePlaceId,
            }
          : null,
      });
      setError(null);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Failed to confirm place");
    }
  }

  async function handleEditInstagramStop(stop: ComposerStop) {
    const draftId = stop.originalDraftId;
    if (!draftId) return;
    setError(null);
    try {
      const draft = await fetchJson<InstagramDraftResponse>(
        `/api/instagram-imports/drafts/${encodeURIComponent(draftId)}`
      );
      setEditingStopId(stop.id);
      setEditingInstagramDraft(draft);
      setModalMode("edit_instagram");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Instagram draft");
    }
  }

  async function handleSaveEditingInstagramDraft() {
    if (!editingInstagramDraft) return;
    setIsSavingEditingInstagramDraft(true);
    setError(null);
    try {
      await patchEditingInstagramDraft({
        editedTitle: editingInstagramTitleInput,
        editedScript: editingInstagramScriptInput,
        placeQuery: editingInstagramPlaceQueryInput,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save draft");
    } finally {
      setIsSavingEditingInstagramDraft(false);
    }
  }

  async function handleSearchEditingInstagramPlaces() {
    if (!editingInstagramDraft) return;
    setIsSearchingEditingInstagramPlaces(true);
    setEditingInstagramSearchError(null);
    try {
      const response = await fetchJson<{ candidates?: InstagramPlaceCandidate[] }>(
        `/api/instagram-imports/drafts/${encodeURIComponent(editingInstagramDraft.id)}/places/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: editingInstagramPlaceQueryInput }),
        }
      );
      const candidates = response.candidates || [];
      setEditingInstagramPlaceResults(candidates);
      if (candidates.length === 0) {
        setEditingInstagramSearchError("No matching places were found.");
      }
    } catch (placeError) {
      setEditingInstagramSearchError(
        placeError instanceof Error ? placeError.message : "Failed to search places"
      );
    } finally {
      setIsSearchingEditingInstagramPlaces(false);
    }
  }

  async function handleConfirmEditingInstagramPlace(candidate: InstagramPlaceCandidate | null) {
    try {
      await patchEditingInstagramDraft({
        placeQuery: editingInstagramPlaceQueryInput,
        confirmedPlace: candidate
          ? {
              label: candidate.label,
              lat: candidate.lat,
              lng: candidate.lng,
              imageUrl: candidate.imageUrl,
              googlePlaceId: candidate.googlePlaceId,
            }
          : null,
      });
      setError(null);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Failed to confirm place");
    }
  }

  async function handleUpdateInstagramStop() {
    if (!editingInstagramDraft || !editingStopId) return;
    setError(null);
    try {
      const latestDraft = (await persistEditingInstagramDraftEdits()) || editingInstagramDraft;
      const mappedStop = mapSocialDraftToComposerStop("instagram", latestDraft);
      if (!mappedStop) {
        throw new Error("Instagram draft needs a title, script, and place before it can be updated.");
      }
      const nextStops = stops.map((stop) =>
          stop.id === editingStopId
            ? {
                ...mappedStop,
                id: stop.id,
              }
            : stop
      );
      await persistMixedComposerSession({ stops: nextStops }, { createIfMissing: true });
      setStops(nextStops);
      closeEditingInstagramModal();
      setModalMode("closed");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to update Instagram stop");
    }
  }

  async function handleSelectInstagramImportedDraft(nextDraftId: string) {
    if (nextDraftId === instagramDraft?.id) return;
    setError(null);
    try {
      const latestDraft = (await persistInstagramDraftEdits()) || instagramDraft;
      if (latestDraft) {
        setInstagramDraftsById((current) => ({
          ...current,
          [latestDraft.id]: latestDraft,
        }));
      }
      const nextDraft =
        instagramDraftsById[nextDraftId] || (await loadInstagramDraftWithRetry(nextDraftId));
      setInstagramDraft(nextDraft);
      setInstagramDraftsById((current) => ({
        ...current,
        [nextDraft.id]: nextDraft,
      }));
      await persistMixedComposerSession(
        {
          activeProvider: "instagram",
          instagramDraftId: nextDraft.id,
          instagramDraftIds,
        },
        { createIfMissing: true }
      );
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Failed to switch Instagram draft");
    }
  }

  function toggleInstagramDraftSelection(draftId: string) {
    setInstagramSelectedDraftIds((current) =>
      current.includes(draftId)
        ? current.filter((candidateId) => candidateId !== draftId)
        : instagramDraftIds.filter((candidateId) =>
            candidateId === draftId || current.includes(candidateId)
          )
    );
  }

  async function handleAddInstagramStopToRoute() {
    if (!instagramDraft) return;
    setError(null);
    try {
      const latestDraft = (await persistInstagramDraftEdits()) || instagramDraft;
      const selectedDraftIds =
        instagramSelectedDraftIds.length > 0 ? instagramSelectedDraftIds : instagramDraftIds;
      if (selectedDraftIds.length === 0) {
        throw new Error("Select at least one Instagram stop before adding it to the route.");
      }

      const draftIdsToAdd =
        instagramDraftIds.length > 0 ? instagramDraftIds.filter((draftId) => selectedDraftIds.includes(draftId)) : [latestDraft.id];
      const selectedDrafts = await Promise.all(
        draftIdsToAdd.map(async (draftId) => {
          if (draftId === latestDraft.id) return latestDraft;
          return instagramDraftsById[draftId] || (await loadInstagramDraftWithRetry(draftId));
        })
      );
      const mappedStops = selectedDrafts.map((draft) => mapSocialDraftToComposerStop("instagram", draft));
      if (mappedStops.some((stop) => !stop)) {
        throw new Error("Every selected Instagram draft needs a title, script, and place before it can be added.");
      }
      const nextStops = dedupeStops([
        ...stops,
        ...(mappedStops.filter((stop): stop is ComposerStop => Boolean(stop))),
      ]);
      await persistMixedComposerSession(
        {
          stops: nextStops,
          instagramDraftId: null,
          instagramDraftIds: [],
          activeProvider: "instagram",
        },
        { createIfMissing: true }
      );
      setStops(nextStops);
      clearInstagramDraftEditor();
      setModalMode("closed");
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add Instagram stop");
    }
  }

  async function handleAddTikTokStopToRoute() {
    if (!tiktokDraft) return;
    setError(null);
    try {
      const latestDraft = (await persistTikTokDraftEdits()) || tiktokDraft;
      const next = mapSocialDraftToComposerStop("tiktok", latestDraft);
      if (!next) {
        throw new Error("TikTok draft needs a title, script, and place before it can be added.");
      }
      const nextStops = dedupeStops([...stops, next]);
      await persistMixedComposerSession(
        {
          stops: nextStops,
          tiktokDraftId: null,
          activeProvider: "tiktok",
        },
        { createIfMissing: true }
      );
      setStops(nextStops);
      clearTikTokDraftEditor();
      setModalMode("closed");
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add TikTok stop");
    }
  }

  async function handleAddGooglePlaceStop(result: GooglePlaceCandidate) {
    setError(null);
    const nextDraft = createGooglePlaceDraft(
      result,
      narratorSignature,
      draftRouteSignature
    );
    setGooglePlaceDraft(nextDraft);
    setStopEntryMode("google_places");
    setModalMode("google_place_editor");
    await persistMixedComposerSession(
      {
        activeProvider: "google_places",
        googlePlaceDraft: nextDraft,
      },
      { createIfMissing: true }
    );
    void generateGooglePlaceDraftScript(nextDraft, narratorSignature, draftRouteSignature);
  }

  async function handleAddGooglePlaceDraftToRoute() {
    if (!googlePlaceDraft) return;
    setError(null);
    const title = toNullableTrimmed(googlePlaceDraft.title);
    const script = toNullableTrimmed(googlePlaceDraft.script);
    if (!title || !script) {
      setError("Google place draft needs a title and script before it can be added.");
      return;
    }

    try {
      const nextStops = dedupeStops([
        ...stops,
        mapGooglePlaceDraftToComposerStop({
          ...googlePlaceDraft,
          title,
          script,
        }),
      ]);
      await persistMixedComposerSession(
        {
          activeProvider: "google_places",
          stops: nextStops,
          googlePlaceDraft: null,
        },
        { createIfMissing: true }
      );
      setStops(nextStops);
      setGooglePlaceDraft(null);
      setModalMode("closed");
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add Google place stop");
    }
  }

  async function handleEditGooglePlaceStop(stop: ComposerStop) {
    setError(null);
    const draft = mapComposerStopToGooglePlaceDraft(stop);
    if (!draft) {
      setError("Only Google Place stops can be edited here.");
      return;
    }
    setEditingGooglePlaceStopId(stop.id);
    setGooglePlaceDraft(draft);
    setStopEntryMode("google_places");
    setModalMode("google_place_editor");
  }

  async function handleUpdateGooglePlaceStop() {
    if (!googlePlaceDraft || !editingGooglePlaceStopId) return;
    setError(null);
    const title = toNullableTrimmed(googlePlaceDraft.title);
    const script = toNullableTrimmed(googlePlaceDraft.script);
    if (!title || !script) {
      setError("Google place draft needs a title and script before it can be updated.");
      return;
    }

    const stop = stops.find((candidate) => candidate.id === editingGooglePlaceStopId);
    if (!stop) {
      setError("Google place stop could not be found.");
      return;
    }

    const updatedStop = mapGooglePlaceDraftOntoComposerStop(stop, {
      ...googlePlaceDraft,
      title,
      script,
    });
    if (!updatedStop) {
      setError("Failed to map the updated Google place stop.");
      return;
    }

    try {
      const nextStops = stops.map((candidate) =>
        candidate.id === editingGooglePlaceStopId ? updatedStop : candidate
      );
      await persistMixedComposerSession(
        {
          stops: nextStops,
        },
        { createIfMissing: true }
      );
      setStops(nextStops);
      closeEditingGooglePlaceModal();
      setModalMode("closed");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to update Google place stop");
    }
  }

  async function handleRetryGooglePlaceScript() {
    if (!googlePlaceDraft) return;
    setError(null);
    const editingStopIndex = editingGooglePlaceStopId
      ? stops.findIndex((stop) => stop.id === editingGooglePlaceStopId)
      : -1;
    const stopIndex = editingStopIndex >= 0 ? editingStopIndex : stops.length;
    const totalStops = editingStopIndex >= 0 ? stops.length : stops.length + 1;
    const routeSignature = createGooglePlaceRouteSignature(stopIndex, totalStops);
    await generateGooglePlaceDraftScript(
      {
        ...googlePlaceDraft,
        scriptEditedByUser: false,
      },
      narratorSignature,
      routeSignature,
      {
        stopIndex,
        totalStops,
        persistSession: !editingGooglePlaceStopId,
      }
    );
  }

  async function handleClearStops() {
    await persistMixedComposerSession({ stops: [] }, { createIfMissing: true });
    setStops([]);
  }

  async function handleMoveStop(index: number, targetIndex: number) {
    const nextStops = moveComposerStop(stops, index, targetIndex);
    if (nextStops === stops) return;
    await persistMixedComposerSession({ stops: nextStops }, { createIfMissing: true });
    setStops(nextStops);
  }

  async function handleRemoveStop(stopId: string) {
    const nextStops = stops.filter((candidate) => candidate.id !== stopId);
    await persistMixedComposerSession({ stops: nextStops }, { createIfMissing: true });
    setStops(nextStops);
  }

  const finalizeImportedDraft = useEffectEvent((provider: Provider, draftIds: string[]) => {
    setStopEntryMode(provider);
    setImportJobState(null);
    setImportUrl("");
    setModalMode(provider === "instagram" ? "instagram_editor" : "tiktok_editor");

    void (async () => {
      try {
        if (provider === "instagram") {
          const normalizedDraftIds = draftIds.filter((draftId): draftId is string => Boolean(toNullableTrimmed(draftId)));
          const drafts = await loadInstagramDraftCollection(normalizedDraftIds);
          await persistMixedComposerSession(
            {
              activeProvider: "instagram",
              instagramDraftId: drafts[0]?.id || null,
              instagramDraftIds: normalizedDraftIds,
              activeImportJob: null,
            },
            { createIfMissing: true }
          );
        } else {
          const draft = await loadTikTokDraftWithRetry(draftIds[0] || "");
          setTikTokDraft(draft);
          await persistMixedComposerSession(
            {
              activeProvider: "tiktok",
              tiktokDraftId: draft.id,
              activeImportJob: null,
            },
            { createIfMissing: true }
          );
        }
        setError(null);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : `Failed to load ${provider === "instagram" ? "Instagram" : "TikTok"} draft`
        );
      }
    })();
  });

  useEffect(() => {
    if (!isInitialStateReady) return;

    const hasTextState =
      Boolean(toNullableTrimmed(routeTitle)) || Boolean(toNullableTrimmed(customNarratorGuidance));
    if (!sessionId && !hasTextState) return;

    const timeoutId = window.setTimeout(() => {
      void persistMixedComposerSession(undefined, {
        createIfMissing: !sessionId && hasTextState,
      });
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    customNarratorGuidance,
    isInitialStateReady,
    persistMixedComposerSession,
    routeTitle,
    sessionId,
  ]);

  useEffect(() => {
    if (!isInitialStateReady || !sessionId) return;
    void persistMixedComposerSession();
  }, [
    googlePlaceDraft,
    importJobState?.draftId,
    importJobState?.jobId,
    importJobState?.provider,
    instagramDraft?.id,
    isInitialStateReady,
    persistMixedComposerSession,
    sessionId,
    stopEntryMode,
    stops,
    tiktokDraft?.id,
  ]);

  useEffect(() => {
    if (!googlePlaceDraft) return;
    if (editingGooglePlaceStopId) return;
    if (googlePlaceDraft.scriptEditedByUser) return;
    if (googlePlaceDraft.status === "generating_script") return;
    if (
      googlePlaceDraft.generatedNarratorSignature === narratorSignature &&
      googlePlaceDraft.generatedRouteSignature === draftRouteSignature
    ) {
      return;
    }

    void generateGooglePlaceDraftScript(
      {
        ...googlePlaceDraft,
        scriptEditedByUser: false,
      },
      narratorSignature,
      draftRouteSignature
    );
  }, [
    draftRouteSignature,
    editingGooglePlaceStopId,
    generateGooglePlaceDraftScript,
    googlePlaceDraft,
    narratorSignature,
  ]);

  async function publishRoute() {
    if (stops.length === 0) {
      setError("Add at least one stop before publishing.");
      return;
    }
    const trimmedNarratorGuidance = customNarratorGuidance.trim();
    const persona: Persona = trimmedNarratorGuidance ? "custom" : "adult";

    setError(null);
    setIsPublishing(true);
    try {
      const publishStops = await regenerateStaleGooglePlaceStops(stops);
      const result = await fetchJson<CreateMixResponse>("/api/mix-jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: MIX_ROUTE_CITY,
          transportMode: "walk",
          lengthMinutes: 30,
          persona,
          narratorGuidance: trimmedNarratorGuidance || null,
          source: "manual",
          routeTitle: routeTitle.trim() || null,
          routeAttribution: attribution.storyBySource
            ? {
                storyBy: attribution.storyBy,
                storyByUrl: attribution.storyByUrl,
                storyByAvatarUrl: attribution.storyByAvatarUrl,
                storyBySource: attribution.storyBySource,
              }
            : null,
          stops: publishStops.map((stop) => ({
            id: stop.id,
            title: stop.title,
            lat: stop.lat,
            lng: stop.lng,
            image: stop.image,
            googlePlaceId: stop.googlePlaceId || undefined,
            sourceProvider: stop.provider,
            sourceKind: stop.kind,
            sourceUrl: stop.sourceUrl || null,
            sourceId: stop.sourceId || null,
            sourceCreatorName: stop.creatorName || null,
            sourceCreatorUrl: stop.creatorUrl || null,
            sourceCreatorAvatarUrl: stop.creatorAvatarUrl || null,
            prefilledScript: stop.script || null,
          })),
        }),
      });
      if (!result.jamId) {
        throw new Error(result.error || "Failed to create route");
      }
      router.replace(`/?jam=${result.jamId}`);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Failed to publish route");
    } finally {
      setIsPublishing(false);
    }
  }

  function renderInstagramDraftEditor(mode: "add" | "edit") {
    const draft = mode === "add" ? instagramDraft : editingInstagramDraft;
    const titleInput = mode === "add" ? instagramTitleInput : editingInstagramTitleInput;
    const scriptInput = mode === "add" ? instagramScriptInput : editingInstagramScriptInput;
    const placeQueryInput =
      mode === "add" ? instagramPlaceQueryInput : editingInstagramPlaceQueryInput;
    const placeResults = mode === "add" ? instagramPlaceResults : editingInstagramPlaceResults;
    const searchError = mode === "add" ? instagramSearchError : editingInstagramSearchError;
    const confirmedPlace =
      mode === "add" ? instagramConfirmedPlace : editingInstagramConfirmedPlace;
    const suggestedPlace =
      mode === "add" ? instagramSuggestedPlace : editingInstagramSuggestedPlace;
    const isSaving = mode === "add" ? isSavingInstagramDraft : isSavingEditingInstagramDraft;
    const isSearching =
      mode === "add" ? isSearchingInstagramPlaces : isSearchingEditingInstagramPlaces;
    const onTitleChange =
      mode === "add" ? setInstagramTitleInput : setEditingInstagramTitleInput;
    const onScriptChange =
      mode === "add" ? setInstagramScriptInput : setEditingInstagramScriptInput;
    const onPlaceQueryChange =
      mode === "add" ? setInstagramPlaceQueryInput : setEditingInstagramPlaceQueryInput;
    const onSave =
      mode === "add" ? handleSaveInstagramDraft : handleSaveEditingInstagramDraft;
    const onSearch =
      mode === "add" ? handleSearchInstagramPlaces : handleSearchEditingInstagramPlaces;
    const onConfirm =
      mode === "add" ? handleConfirmInstagramPlace : handleConfirmEditingInstagramPlace;
    const primaryAction =
      mode === "add" ? handleAddInstagramStopToRoute : handleUpdateInstagramStop;
    const isInstagramCollectionReview = mode === "add" && instagramDraftIds.length > 1;
    const primaryLabel =
      mode === "add"
        ? isInstagramCollectionReview
          ? "Add selected stops to route"
          : "Add stop to route"
        : "Update stop";

    if (!draft) {
      return (
        <div className={styles.statusPanel}>
          <div className={styles.statusEyebrow}>Instagram import</div>
          <div className={styles.statusMessage}>Loading draft editor...</div>
          <p className={styles.statusCopy}>
            The import finished. We&apos;re opening the editable draft now.
          </p>
        </div>
      );
    }

    return (
      <div className={styles.instagramDraftGrid}>
        <section className={styles.entryPanel}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Instagram Source</h3>
            <span className={styles.metaLabel}>
              {draft.source.kind === "reel" ? "Reel" : "Post"}
            </span>
          </div>
          {draft.source.thumbnailUrl ? (
            <div className={styles.preview}>
              <Image src={draft.source.thumbnailUrl} alt="" fill unoptimized className={styles.previewImage} />
            </div>
          ) : null}
          <div className={styles.copyBlock}>
            <div><span className={styles.metaLabel}>Owner</span> {draft.source.ownerTitle || "Unknown creator"}</div>
            <div>
              <span className={styles.metaLabel}>Shortcode</span>{" "}
              <a href={draft.source.url} target="_blank" rel="noreferrer" className={styles.openLink}>
                {draft.source.shortcode}
              </a>
            </div>
            <div>
              <span className={styles.metaLabel}>Extracted text est.</span>{" "}
              {formatTokenEstimate(draft.metrics.extractedTextTokensEstimate)}
            </div>
            <div>
              <span className={styles.metaLabel}>Cleaned text est.</span>{" "}
              {formatTokenEstimate(draft.metrics.cleanedTextTokensEstimate)}
            </div>
          </div>
          {draft.warning ? <div className={styles.warningBanner}>{draft.warning}</div> : null}
          {draft.source.caption ? (
            <div className={styles.captionBlock}>
              <div className={styles.metaLabel}>Caption</div>
              <p>{draft.source.caption}</p>
            </div>
          ) : null}
        </section>

        <section className={styles.entryPanel}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Stop/Story editor</h3>
            <span className={styles.metaLabel}>{mode === "add" ? "Imported draft" : "Draft editor"}</span>
          </div>
          {isInstagramCollectionReview ? (
            <div className={styles.instagramCollectionEditor}>
              <div className={styles.metaLabel}>
                {instagramSelectedDraftIds.length}/{instagramDraftIds.length} generated stops selected
              </div>
              <div className={styles.instagramCollectionList}>
                {instagramDraftIds.map((draftId, index) => {
                  const candidateDraft = instagramDraftsById[draftId] ?? null;
                  const isSelectedDraft = instagramSelectedDraftIds.includes(draftId);
                  const isActiveDraft = instagramDraft?.id === draftId;
                  return (
                    <div
                      key={draftId}
                      className={`${styles.instagramCollectionRow} ${isActiveDraft ? styles.instagramCollectionRowActive : ""}`}
                    >
                      <button
                        type="button"
                        className={styles.instagramCollectionSelect}
                        onClick={() => void handleSelectInstagramImportedDraft(draftId)}
                      >
                        <div className={styles.instagramCollectionIndex}>{index + 1}</div>
                        <div>
                          <div className={styles.placeTitle}>
                            {candidateDraft?.content.finalTitle ||
                              candidateDraft?.content.generatedTitle ||
                              candidateDraft?.location.confirmedPlace?.label ||
                              candidateDraft?.location.suggestedPlace?.label ||
                              draftId}
                          </div>
                          <div className={styles.stopMeta}>
                            {candidateDraft?.location.confirmedPlace?.label ||
                              candidateDraft?.location.suggestedPlace?.label ||
                              "Needs place review"}
                          </div>
                        </div>
                      </button>
                      <label className={styles.instagramCollectionToggle}>
                        <input
                          type="checkbox"
                          checked={isSelectedDraft}
                          onChange={() => toggleInstagramDraftSelection(draftId)}
                        />
                        <span>Select</span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <label className={styles.fieldLabel}>
            Title of Stop
            <input
              type="text"
              value={titleInput}
              onChange={(event) => onTitleChange(event.target.value)}
              className={styles.textInput}
            />
          </label>
          <label className={styles.fieldLabel}>
            Script
            <textarea
              value={scriptInput}
              onChange={(event) => onScriptChange(event.target.value)}
              rows={12}
              className={styles.textarea}
            />
          </label>
          <div className={styles.actionRow}>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={isSaving}
              className={styles.secondaryButton}
            >
              {isSaving ? "Saving..." : "Save changes"}
            </button>
          </div>
          {draft.latestJob?.status === "failed" ? (
            <div className={styles.errorBanner}>
              {draft.latestJob.error || "The last job failed."}
            </div>
          ) : null}
        </section>

        <section className={`${styles.entryPanel} ${styles.locationPanel}`}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Location confirmation</h3>
            <span className={styles.metaLabel}>Required</span>
          </div>
          <div className={styles.formRow}>
            <input
              type="text"
              value={placeQueryInput}
              onChange={(event) => onPlaceQueryChange(event.target.value)}
              className={styles.textInput}
              placeholder="Search a place"
            />
            <button
              type="button"
              onClick={() => void onSearch()}
              disabled={isSearching}
              className={styles.secondaryButton}
            >
              {isSearching ? "Searching..." : "Search"}
            </button>
          </div>
          {searchError ? <div className={styles.errorBanner}>{searchError}</div> : null}

          {confirmedPlace ? (
            <div className={styles.confirmedPlace}>
              <div>
                <div className={styles.metaLabel}>Confirmed place</div>
                <div className={styles.placeTitle}>{confirmedPlace.label}</div>
                {confirmedPlace.formattedAddress ? (
                  <div className={styles.placeAddress}>{confirmedPlace.formattedAddress}</div>
                ) : null}
              </div>
              <button type="button" onClick={() => void onConfirm(null)} className={styles.linkButton}>
                Clear
              </button>
            </div>
          ) : suggestedPlace ? (
            <button
              type="button"
              onClick={() => void onConfirm(suggestedPlace)}
              className={styles.suggestedButton}
            >
              Use suggested place: {suggestedPlace.label}
            </button>
          ) : null}

          <div className={styles.placeList}>
            {placeResults.map((candidate) => (
              <button
                key={`${candidate.googlePlaceId || `${candidate.lat},${candidate.lng}`}`}
                type="button"
                onClick={() => void onConfirm(candidate)}
                className={styles.placeRow}
              >
                <div>
                  <div className={styles.placeTitle}>{candidate.label}</div>
                  {candidate.formattedAddress ? (
                    <div className={styles.placeAddress}>{candidate.formattedAddress}</div>
                  ) : null}
                </div>
                <span className={styles.placeAction}>Use</span>
              </button>
            ))}
          </div>

          <div className={styles.actionRow}>
            <button
              type="button"
              onClick={() => void primaryAction()}
              disabled={isSaving || isSearching || (isInstagramCollectionReview && instagramSelectedDraftIds.length === 0)}
              className={styles.primaryButton}
            >
              {primaryLabel}
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderTikTokDraftEditor() {
    if (!tiktokDraft) {
      return (
        <div className={styles.statusPanel}>
          <div className={styles.statusEyebrow}>TikTok import</div>
          <div className={styles.statusMessage}>Loading draft editor...</div>
          <p className={styles.statusCopy}>
            The import finished. We&apos;re opening the editable draft now.
          </p>
        </div>
      );
    }

    return (
      <div className={styles.instagramDraftGrid}>
        <section className={styles.entryPanel}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>TikTok Source</h3>
            <span className={styles.metaLabel}>Video</span>
          </div>
          {tiktokDraft.source.thumbnailUrl ? (
            <div className={styles.preview}>
              <Image src={tiktokDraft.source.thumbnailUrl} alt="" fill unoptimized className={styles.previewImage} />
            </div>
          ) : null}
          <div className={styles.copyBlock}>
            <div><span className={styles.metaLabel}>Owner</span> {tiktokDraft.source.ownerTitle || "Unknown creator"}</div>
            <div>
              <span className={styles.metaLabel}>Video</span>{" "}
              <a href={tiktokDraft.source.url} target="_blank" rel="noreferrer" className={styles.openLink}>
                {tiktokDraft.source.videoId || "Open source"}
              </a>
            </div>
            <div>
              <span className={styles.metaLabel}>Extracted text est.</span>{" "}
              {formatTokenEstimate(tiktokDraft.metrics.extractedTextTokensEstimate)}
            </div>
            <div>
              <span className={styles.metaLabel}>Cleaned text est.</span>{" "}
              {formatTokenEstimate(tiktokDraft.metrics.cleanedTextTokensEstimate)}
            </div>
          </div>
          {tiktokDraft.warning ? <div className={styles.warningBanner}>{tiktokDraft.warning}</div> : null}
          {tiktokDraft.source.caption ? (
            <div className={styles.captionBlock}>
              <div className={styles.metaLabel}>Caption</div>
              <p>{tiktokDraft.source.caption}</p>
            </div>
          ) : null}
        </section>

        <section className={styles.entryPanel}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Stop/Story editor</h3>
            <span className={styles.metaLabel}>Imported draft</span>
          </div>
          <label className={styles.fieldLabel}>
            Title of Stop
            <input
              type="text"
              value={tiktokTitleInput}
              onChange={(event) => setTikTokTitleInput(event.target.value)}
              className={styles.textInput}
            />
          </label>
          <label className={styles.fieldLabel}>
            Script
            <textarea
              value={tiktokScriptInput}
              onChange={(event) => setTikTokScriptInput(event.target.value)}
              rows={12}
              className={styles.textarea}
            />
          </label>
          <div className={styles.actionRow}>
            <button
              type="button"
              onClick={() => void handleSaveTikTokDraft()}
              disabled={isSavingTikTokDraft}
              className={styles.secondaryButton}
            >
              {isSavingTikTokDraft ? "Saving..." : "Save changes"}
            </button>
          </div>
          {tiktokDraft.latestJob?.status === "failed" ? (
            <div className={styles.errorBanner}>
              {tiktokDraft.latestJob.error || "The last job failed."}
            </div>
          ) : null}
        </section>

        <section className={`${styles.entryPanel} ${styles.locationPanel}`}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Location confirmation</h3>
            <span className={styles.metaLabel}>Required</span>
          </div>
          <div className={styles.formRow}>
            <input
              type="text"
              value={tiktokPlaceQueryInput}
              onChange={(event) => setTikTokPlaceQueryInput(event.target.value)}
              className={styles.textInput}
              placeholder="Search a place"
            />
            <button
              type="button"
              onClick={() => void handleSearchTikTokPlaces()}
              disabled={isSearchingTikTokPlaces}
              className={styles.secondaryButton}
            >
              {isSearchingTikTokPlaces ? "Searching..." : "Search"}
            </button>
          </div>
          {tiktokSearchError ? <div className={styles.errorBanner}>{tiktokSearchError}</div> : null}

          {tiktokConfirmedPlace ? (
            <div className={styles.confirmedPlace}>
              <div>
                <div className={styles.metaLabel}>Confirmed place</div>
                <div className={styles.placeTitle}>{tiktokConfirmedPlace.label}</div>
                {tiktokConfirmedPlace.formattedAddress ? (
                  <div className={styles.placeAddress}>{tiktokConfirmedPlace.formattedAddress}</div>
                ) : null}
              </div>
              <button type="button" onClick={() => void handleConfirmTikTokPlace(null)} className={styles.linkButton}>
                Clear
              </button>
            </div>
          ) : tiktokSuggestedPlace ? (
            <button
              type="button"
              onClick={() => void handleConfirmTikTokPlace(tiktokSuggestedPlace)}
              className={styles.suggestedButton}
            >
              Use suggested place: {tiktokSuggestedPlace.label}
            </button>
          ) : null}

          <div className={styles.placeList}>
            {tiktokPlaceResults.map((candidate) => (
              <button
                key={`${candidate.googlePlaceId || `${candidate.lat},${candidate.lng}`}`}
                type="button"
                onClick={() => void handleConfirmTikTokPlace(candidate)}
                className={styles.placeRow}
              >
                <div>
                  <div className={styles.placeTitle}>{candidate.label}</div>
                  {candidate.formattedAddress ? (
                    <div className={styles.placeAddress}>{candidate.formattedAddress}</div>
                  ) : null}
                </div>
                <span className={styles.placeAction}>Use</span>
              </button>
            ))}
          </div>

          <div className={styles.actionRow}>
            <button
              type="button"
              onClick={() => void handleAddTikTokStopToRoute()}
              disabled={isSavingTikTokDraft || isSearchingTikTokPlaces}
              className={styles.primaryButton}
            >
              Add stop to route
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderGooglePlaceDraftEditor() {
    if (!googlePlaceDraft) {
      return (
        <div className={styles.statusPanel}>
          <div className={styles.statusEyebrow}>Google Place</div>
          <div className={styles.statusMessage}>Loading draft editor...</div>
          <p className={styles.statusCopy}>
            We&apos;re restoring your Google Place draft.
          </p>
        </div>
      );
    }

    const mode = editingGooglePlaceStopId ? "edit" : "add";
    const isGeneratingScript = googlePlaceDraft.status === "generating_script";
    const trimmedScript = toNullableTrimmed(googlePlaceDraft.script);

    return (
      <div className={styles.instagramDraftGrid}>
        <section className={styles.entryPanel}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Google Place</h3>
            <span className={styles.metaLabel}>{mode === "edit" ? "Existing stop" : "Selected stop"}</span>
          </div>
          {googlePlaceDraft.place.image ? (
            <div className={styles.preview}>
              <Image
                src={googlePlaceDraft.place.image}
                alt={googlePlaceDraft.place.title}
                fill
                unoptimized
                className={styles.previewImage}
              />
            </div>
          ) : null}
          <div className={styles.copyBlock}>
            <div><span className={styles.metaLabel}>Place</span> {googlePlaceDraft.place.title}</div>
            <div>
              <span className={styles.metaLabel}>Google Place ID</span>{" "}
              {googlePlaceDraft.place.googlePlaceId || "Not provided"}
            </div>
            <div>
              <span className={styles.metaLabel}>Coordinates</span>{" "}
              {googlePlaceDraft.place.lat}, {googlePlaceDraft.place.lng}
            </div>
            <div>
              <span className={styles.metaLabel}>Narrator</span>{" "}
              {resolveGooglePlaceDraftPersona(customNarratorGuidance) === "custom" ? "Custom narrator" : "AI Historian"}
            </div>
          </div>
        </section>

        <section className={styles.entryPanel}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Stop/Story editor</h3>
            <span className={styles.metaLabel}>{mode === "edit" ? "Draft editor" : "Generated draft"}</span>
          </div>
          <label className={styles.fieldLabel}>
            Title of Stop
            <input
              type="text"
              value={googlePlaceDraft.title}
              onChange={(event) => {
                setGooglePlaceDraft((current) =>
                  current
                    ? {
                        ...current,
                        title: event.target.value,
                      }
                    : current
                );
              }}
              className={styles.textInput}
            />
          </label>
          <label className={styles.fieldLabel}>
            Script
            <textarea
              value={googlePlaceDraft.script || ""}
              onChange={(event) => {
                setGooglePlaceDraft((current) =>
                  current
                    ? {
                        ...current,
                        script: event.target.value,
                        scriptEditedByUser: true,
                        status: "ready",
                        error: null,
                      }
                    : current
                );
              }}
              rows={12}
              className={styles.textarea}
              placeholder={isGeneratingScript ? "Generating script..." : "Add your script"}
              disabled={isGeneratingScript}
            />
          </label>
          <div className={styles.actionRow}>
            {mode === "add" ? (
              <button
                type="button"
                onClick={() => void handleSaveGooglePlaceDraft()}
                disabled={isSavingGooglePlaceDraft}
                className={styles.secondaryButton}
              >
                {isSavingGooglePlaceDraft ? "Saving..." : "Save changes"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleRetryGooglePlaceScript()}
              disabled={isGeneratingScript}
              className={styles.secondaryButton}
            >
              {isGeneratingScript ? "Generating..." : "Regenerate script"}
            </button>
          </div>
          {googlePlaceDraft.error ? (
            <div className={styles.errorBanner}>{googlePlaceDraft.error}</div>
          ) : null}
          {!trimmedScript && isGeneratingScript ? (
            <p className={styles.statusCopy}>
              We&apos;re generating the first script from your current narrator guidance.
            </p>
          ) : null}
        </section>

        <section className={`${styles.entryPanel} ${styles.locationPanel}`}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Location confirmation</h3>
            <span className={styles.metaLabel}>Locked</span>
          </div>
          <div className={styles.confirmedPlace}>
            <div>
              <div className={styles.metaLabel}>Confirmed place</div>
              <div className={styles.placeTitle}>{googlePlaceDraft.place.title}</div>
            </div>
          </div>
          <div className={styles.metadataGrid}>
            <div>
              <div className={styles.metaLabel}>Lat / Lng</div>
              <div className={styles.metadataValue}>
                {googlePlaceDraft.place.lat}, {googlePlaceDraft.place.lng}
              </div>
            </div>
            <div>
              <div className={styles.metaLabel}>Source ID</div>
              <div className={styles.metadataValue}>{googlePlaceDraft.place.id}</div>
            </div>
          </div>
          <div className={styles.actionRow}>
            <button
              type="button"
              onClick={() =>
                void (mode === "edit"
                  ? handleUpdateGooglePlaceStop()
                  : handleAddGooglePlaceDraftToRoute())
              }
              disabled={isGeneratingScript || !trimmedScript}
              className={styles.primaryButton}
            >
              {mode === "edit" ? "Update stop" : "Add stop to route"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.headerRow}>
          <div>
            <Link href="/" className={styles.backLink}>
              Back
            </Link>
            <p className={styles.kicker}>Mixed Composer</p>
            <h1 className={styles.title}>Build a route from Instagram, TikTok, and Google Places</h1>
            <p className={styles.subtitle}>
              This is the new mixed-source route builder. The original Instagram uploader stays live while we prove this flow.
            </p>
          </div>
          <div className={styles.headerLinks}>
            <Link href="/import/instagram" className={styles.headerLinkPill}>Instagram uploader</Link>
            <Link href="/import/tiktok" className={styles.headerLinkPill}>TikTok importer</Link>
          </div>
        </div>

        <section className={`${styles.card} ${styles.titleCard}`}>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>Route title</span>
              <input value={routeTitle} onChange={(event) => setRouteTitle(event.target.value)} placeholder="Weekend food route" />
            </label>
          </div>
          <div className={styles.customNarratorPanel}>
            <div className={styles.customNarratorLabel}>Narrator</div>
            <p className={styles.customNarratorHelp}>{CUSTOM_NARRATOR_HELP_TEXT}</p>
            <textarea
              id="customNarratorGuidance"
              value={customNarratorGuidance}
              onChange={(event) => {
                setError(null);
                setCustomNarratorGuidance(event.target.value.slice(0, CUSTOM_NARRATOR_MAX_CHARS));
              }}
              className={styles.customNarratorTextarea}
              placeholder={CUSTOM_NARRATOR_PLACEHOLDER}
              rows={6}
              maxLength={CUSTOM_NARRATOR_MAX_CHARS}
            />
            <div className={styles.customNarratorCount}>
              {customNarratorGuidance.length}/{CUSTOM_NARRATOR_MAX_CHARS}
            </div>
          </div>
        </section>

        <div className={styles.columns}>
          <section className={styles.card}>
            <h2 className={styles.sectionTitle}>Enter a stop from...</h2>
            <div className={styles.segmented}>
              <button
                type="button"
                className={stopEntryMode === "instagram" ? styles.segmentedActive : styles.segmentedButton}
                onClick={() => setStopEntryMode("instagram")}
              >
                Instagram
              </button>
              <button
                type="button"
                className={stopEntryMode === "tiktok" ? styles.segmentedActive : styles.segmentedButton}
                onClick={() => setStopEntryMode("tiktok")}
              >
                TikTok
              </button>
              <button
                type="button"
                className={stopEntryMode === "google_places" ? styles.segmentedActive : styles.segmentedButton}
                onClick={() => setStopEntryMode("google_places")}
              >
                Add Google Place stop
              </button>
            </div>
            {stopEntryMode === "google_places" ? (
              <>
                <div className={styles.inlineRow}>
                  <input
                    value={googleSearchQuery}
                    onChange={(event) => setGoogleSearchQuery(event.target.value)}
                    placeholder="Search places to add"
                  />
                  <button type="button" onClick={() => void searchPlaces()} disabled={isSearchingGooglePlaces}>
                    {isSearchingGooglePlaces ? "Searching..." : "Search"}
                  </button>
                </div>
                {googleSearchResults.length > 0 ? (
                  <div className={styles.results}>
                    {googleSearchResults.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        className={styles.resultRow}
                        onClick={() => void handleAddGooglePlaceStop(result)}
                      >
                        <span className={styles.resultTitle}>{result.title}</span>
                        <span className={styles.resultMeta}>Add place stop</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className={styles.inlineRow}>
                <input
                  value={importUrl}
                  onChange={(event) => setImportUrl(event.target.value)}
                  placeholder={
                    stopEntryMode === "instagram"
                      ? "Paste an Instagram reel or post URL"
                      : "Paste a TikTok video URL"
                  }
                />
                <button type="button" onClick={() => void importSocialDraft()}>Add</button>
              </div>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.listHeader}>
              <h2 className={styles.sectionTitle}>Route stops</h2>
              <button type="button" className={styles.secondaryButton} onClick={() => void handleClearStops()}>Clear</button>
            </div>
            {stops.length === 0 ? (
              <p className={styles.emptyState}>No stops added yet.</p>
            ) : (
              <div className={styles.stopList}>
                {stops.map((stop, index) => (
                  <div key={stop.id} className={styles.stopRow}>
                    <div>
                      <div className={styles.stopTitle}>{index + 1}. {stop.title}</div>
                      <div className={styles.stopMeta}>
                        {stop.provider === "google_places" ? "Google Place" : stop.provider === "instagram" ? "Instagram import" : "TikTok import"}
                      </div>
                    </div>
                    <div className={styles.stopActions}>
                      {stop.provider === "instagram" && stop.originalDraftId ? (
                        <button type="button" onClick={() => void handleEditInstagramStop(stop)}>Edit</button>
                      ) : null}
                      {stop.provider === "google_places" ? (
                        <button type="button" onClick={() => void handleEditGooglePlaceStop(stop)}>Edit</button>
                      ) : null}
                      <button type="button" onClick={() => void handleMoveStop(index, index - 1)} disabled={index === 0}>Up</button>
                      <button type="button" onClick={() => void handleMoveStop(index, index + 1)} disabled={index === stops.length - 1}>Down</button>
                      <button type="button" onClick={() => void handleRemoveStop(stop.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.attributionBox}>
              <div className={styles.attributionLabel}>Route credit</div>
              <div>{attribution.storyBy || "No social creator credit yet"}</div>
            </div>

            {error ? <div className={styles.errorBanner}>{error}</div> : null}

            <button type="button" className={styles.publishButton} onClick={() => void publishRoute()} disabled={isPublishing}>
              {isPublishing ? "Publishing..." : "Publish mixed route"}
            </button>
          </section>
        </div>

        {modalMode !== "closed" ? (
          <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="mixed-modal-title">
            <div className={styles.modalShell}>
              <div className={styles.modalHeader}>
                <h2 id="mixed-modal-title" className={styles.sectionTitle}>
                  {modalMode === "import_status"
                    ? `Importing ${importJobState?.provider === "tiktok" ? "TikTok" : "Instagram"} stop`
                    : modalMode === "instagram_editor"
                      ? instagramDraftIds.length > 1
                        ? "Review Instagram stops"
                        : "Review Instagram import"
                      : modalMode === "tiktok_editor"
                        ? "Review TikTok import"
                      : modalMode === "google_place_editor"
                        ? editingGooglePlaceStopId
                          ? "Edit Google Place stop"
                          : "Review Google Place draft"
                        : "Edit Instagram stop"}
                </h2>
                <button type="button" className={styles.linkButton} onClick={() => closeActiveModal()}>
                  Close
                </button>
              </div>
              {modalMode === "import_status" ? (
                <div className={styles.statusPanel}>
                  <div className={styles.statusEyebrow}>
                    {importJobState?.provider === "tiktok" ? "TikTok import" : "Instagram import"}
                  </div>
                  <div className={styles.statusMessage}>
                    {importJobState?.error || importJobState?.message || "Preparing import..."}
                  </div>
                  <div className={styles.statusProgressTrack} aria-hidden="true">
                    <div
                      className={styles.statusProgressFill}
                      style={{ width: `${Math.max(6, Math.min(importJobState?.progress || 0, 100))}%` }}
                    />
                  </div>
                  <div className={styles.statusMeta}>
                    {Math.round(importJobState?.progress || 0)}% complete
                  </div>
                  {importJobState?.error ? (
                    <div className={styles.errorBanner}>{importJobState.error}</div>
                  ) : (
                    <p className={styles.statusCopy}>
                      We&apos;re fetching the source, generating the draft, and getting it ready for review.
                    </p>
                  )}
                </div>
              ) : modalMode === "instagram_editor" ? (
                renderInstagramDraftEditor("add")
              ) : modalMode === "tiktok_editor" ? (
                renderTikTokDraftEditor()
              ) : modalMode === "google_place_editor" ? (
                renderGooglePlaceDraftEditor()
              ) : (
                renderInstagramDraftEditor("edit")
              )}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
