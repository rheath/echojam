"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  addInstagramCollectionDraftId,
  canMasterPublishInstagramDrafts,
  getInstagramCollectionDraftStatus,
  INSTAGRAM_COLLECTION_MAX_STOPS,
  normalizeInstagramCollectionDraftIds,
  removeInstagramCollectionDraftId,
  toNullableTrimmed,
  type InstagramCollectionDraftStatus,
  type InstagramDraftResponse,
  type InstagramImportJobResponse,
  type InstagramPlaceCandidate,
} from "@/lib/instagramImport";
import styles from "./InstagramImportClient.module.css";

type CreateResponse = {
  draftId?: string;
  jobId?: string;
  error?: string;
};

type PublishResponse = {
  draftId?: string;
  jobId?: string | null;
  publishedJamId?: string | null;
  publishedRouteId?: string | null;
  error?: string;
};

type PublishCollectionResponse = {
  draftId?: string;
  jobId?: string | null;
  publishedJamId?: string | null;
  publishedRouteId?: string | null;
  error?: string;
};

type PlacesResponse = {
  candidates?: InstagramPlaceCandidate[];
  error?: string;
};

type StoredInstagramCollectionSession = {
  draftIds?: string[];
  activeDraftId?: string | null;
  masterPublishJobId?: string | null;
  routeTitle?: string | null;
};

const SESSION_STORAGE_KEY = "instagram-import-session:v1";

function isActiveJob(job: InstagramImportJobResponse | null) {
  return job?.status === "queued" || job?.status === "processing";
}

function isTerminalJob(job: InstagramImportJobResponse | null) {
  return job?.status === "draft_ready" || job?.status === "published" || job?.status === "failed";
}

function preferredPlaceQuery(draft: InstagramDraftResponse | null) {
  return (
    draft?.location.confirmedPlace?.label ||
    draft?.location.suggestedPlace?.label ||
    draft?.location.placeQuery ||
    ""
  );
}

function formatHeading(job: InstagramImportJobResponse | null) {
  if (!job) return "Import from Instagram";
  if (job.phase === "publish_collection") return "Publishing your full route";
  if (job.phase === "publish") return "Publishing to EchoJam";
  return job.status === "failed" ? "Import failed" : "Importing your post";
}

function formatJobLabel(job: InstagramImportJobResponse | null) {
  if (!job) return "Import job";
  if (job.phase === "publish_collection") return "Master publish";
  return job.phase === "publish" ? "Publish job" : "Import job";
}

function formatTokenEstimate(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "Pending";
  return `~${value} tokens`;
}

function formatCollectionStatusLabel(status: InstagramCollectionDraftStatus) {
  switch (status) {
    case "ready":
      return "Ready";
    case "needs_location":
      return "Needs location";
    case "published":
      return "Published";
    case "failed":
      return "Failed";
    default:
      return "Importing";
  }
}

function summarizeCollectionDraft(draft: InstagramDraftResponse | null | undefined, draftId: string) {
  if (!draft) return draftId;
  return (
    draft.content.finalTitle ||
    draft.content.generatedTitle ||
    draft.location.confirmedPlace?.label ||
    draft.location.placeQuery ||
    draft.source.ownerTitle ||
    draft.source.shortcode
  );
}

function describeCollectionDraft(draft: InstagramDraftResponse | null | undefined) {
  if (!draft) return "Loading draft";
  return (
    draft.location.confirmedPlace?.label ||
    draft.location.suggestedPlace?.label ||
    draft.source.ownerTitle ||
    "Instagram import"
  );
}

function readStoredSession(): StoredInstagramCollectionSession {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredInstagramCollectionSession;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

export default function InstagramImportClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftIdFromUrl = searchParams.get("draft");

  const [urlInput, setUrlInput] = useState("");
  const [draft, setDraft] = useState<InstagramDraftResponse | null>(null);
  const [job, setJob] = useState<InstagramImportJobResponse | null>(null);
  const [collectionJob, setCollectionJob] = useState<InstagramImportJobResponse | null>(null);
  const [collectionJobId, setCollectionJobId] = useState<string | null>(null);
  const [collectionDraftIds, setCollectionDraftIds] = useState<string[]>([]);
  const [collectionDrafts, setCollectionDrafts] = useState<Record<string, InstagramDraftResponse>>({});
  const [collectionTitle, setCollectionTitle] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [scriptInput, setScriptInput] = useState("");
  const [placeQueryInput, setPlaceQueryInput] = useState("");
  const [searchResults, setSearchResults] = useState<InstagramPlaceCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoadingDraft, setIsLoadingDraft] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isMasterPublishing, setIsMasterPublishing] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [shouldPersistSession, setShouldPersistSession] = useState(false);
  const restoredCollectionDraftIdsRef = useRef<string[]>([]);

  const activeJob = useMemo(() => (job && isActiveJob(job) ? job : null), [job]);
  const activeCollectionJob = useMemo(
    () => (collectionJob && isActiveJob(collectionJob) ? collectionJob : null),
    [collectionJob]
  );
  const confirmedPlace = draft?.location.confirmedPlace || null;
  const suggestedPlace = draft?.location.suggestedPlace || null;
  const publishedJamId = draft?.publish.publishedJamId || null;
  const collectionEntries = useMemo(
    () =>
      collectionDraftIds.map((draftId) =>
        draft?.id === draftId ? draft : collectionDrafts[draftId] ?? null
      ),
    [collectionDraftIds, collectionDrafts, draft]
  );
  const canAddMoreStops = collectionDraftIds.length < INSTAGRAM_COLLECTION_MAX_STOPS;
  const canMasterPublish = canMasterPublishInstagramDrafts(
    collectionEntries,
    INSTAGRAM_COLLECTION_MAX_STOPS
  );

  const storeDraft = useCallback((nextDraft: InstagramDraftResponse) => {
    setCollectionDrafts((current) => ({
      ...current,
      [nextDraft.id]: nextDraft,
    }));
  }, []);

  const fetchDraftById = useCallback(async (draftId: string) => {
    return await fetchJson<InstagramDraftResponse>(
      `/api/instagram-imports/drafts/${encodeURIComponent(draftId)}`
    );
  }, []);

  const refreshCollectionDrafts = useCallback(async (draftIds: string[]) => {
    if (draftIds.length === 0) return [] as InstagramDraftResponse[];
    const results = await Promise.allSettled(draftIds.map((draftId) => fetchDraftById(draftId)));
    const nextDrafts: Record<string, InstagramDraftResponse> = {};
    const survivingDraftIds: string[] = [];
    const orderedDrafts: InstagramDraftResponse[] = [];

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const draftId = draftIds[index];
      if (result?.status === "fulfilled") {
        nextDrafts[draftId] = result.value;
        survivingDraftIds.push(draftId);
        orderedDrafts.push(result.value);
      }
    }

    if (Object.keys(nextDrafts).length > 0) {
      setCollectionDrafts((current) => ({ ...current, ...nextDrafts }));
    }
    if (survivingDraftIds.length !== draftIds.length) {
      setCollectionDraftIds(survivingDraftIds);
    }
    return orderedDrafts;
  }, [fetchDraftById]);

  const loadDraft = useCallback(async (
    draftId: string,
    opts?: { updateUrl?: boolean; setActive?: boolean; silent?: boolean }
  ) => {
    const shouldSetActive = opts?.setActive !== false;
    if (shouldSetActive && !opts?.silent) {
      setIsLoadingDraft(true);
    }
    try {
      const nextDraft = await fetchDraftById(draftId);
      storeDraft(nextDraft);
      if (shouldSetActive) {
        setDraft(nextDraft);
        setJob(nextDraft.latestJob);
        setUrlInput(nextDraft.source.url);
        setError(null);
        if (opts?.updateUrl !== false) {
          router.replace(`/import/instagram?draft=${encodeURIComponent(draftId)}`);
        }
      }
      return nextDraft;
    } catch (loadError) {
      if (shouldSetActive) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load draft");
      }
      return null;
    } finally {
      if (shouldSetActive && !opts?.silent) {
        setIsLoadingDraft(false);
      }
    }
  }, [fetchDraftById, router, storeDraft]);

  const persistActiveDraftEdits = useCallback(async () => {
    if (!draft) return null;

    const nextEditedTitle = toNullableTrimmed(titleInput);
    const nextEditedScript = toNullableTrimmed(scriptInput);
    const nextPlaceQuery = toNullableTrimmed(placeQueryInput);
    const currentEditedTitle = toNullableTrimmed(draft.content.editedTitle);
    const currentEditedScript = toNullableTrimmed(draft.content.editedScript);
    const currentPlaceQuery = toNullableTrimmed(draft.location.placeQuery);

    if (
      nextEditedTitle === currentEditedTitle &&
      nextEditedScript === currentEditedScript &&
      nextPlaceQuery === currentPlaceQuery
    ) {
      return draft;
    }

    const updated = await fetchJson<InstagramDraftResponse>(
      `/api/instagram-imports/drafts/${encodeURIComponent(draft.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          editedTitle: titleInput,
          editedScript: scriptInput,
          placeQuery: placeQueryInput,
        }),
      }
    );
    setDraft(updated);
    setJob(updated.latestJob);
    storeDraft(updated);
    return updated;
  }, [draft, placeQueryInput, scriptInput, storeDraft, titleInput]);

  useEffect(() => {
    if (sessionReady) return;
    const stored = readStoredSession();
    const normalizedDraftIds = normalizeInstagramCollectionDraftIds(
      stored.draftIds ?? [],
      INSTAGRAM_COLLECTION_MAX_STOPS
    );
    const normalizedActiveDraftId = toNullableTrimmed(stored.activeDraftId);
    const normalizedMasterPublishJobId = toNullableTrimmed(stored.masterPublishJobId);
    const shouldResumeStoredCollection =
      draftIdFromUrl !== null && normalizedDraftIds.includes(draftIdFromUrl);

    restoredCollectionDraftIdsRef.current = normalizedDraftIds;
    setCollectionDraftIds(shouldResumeStoredCollection ? normalizedDraftIds : []);
    setCollectionTitle(shouldResumeStoredCollection ? toNullableTrimmed(stored.routeTitle) || "" : "");
    setCollectionJobId(normalizedMasterPublishJobId);
    setShouldPersistSession(Boolean(draftIdFromUrl));
    setSessionReady(true);

    if (shouldResumeStoredCollection) {
      void refreshCollectionDrafts(normalizedDraftIds);
    }

    if (normalizedMasterPublishJobId) {
      void fetchJson<InstagramImportJobResponse>(
        `/api/instagram-imports/jobs/${encodeURIComponent(normalizedMasterPublishJobId)}`
      )
        .then((nextJob) => {
          setCollectionJob(nextJob);
        })
        .catch(() => {
          setCollectionJobId(null);
        });
    }

    void normalizedActiveDraftId;
  }, [draftIdFromUrl, refreshCollectionDrafts, sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    if (collectionDraftIds.length > 0 || shouldPersistSession) {
      restoredCollectionDraftIdsRef.current = collectionDraftIds;
    }
  }, [collectionDraftIds, sessionReady, shouldPersistSession]);

  useEffect(() => {
    if (!sessionReady) return;
    if (draftIdFromUrl) {
      setShouldPersistSession(true);
    }
  }, [draftIdFromUrl, sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    if (!draftIdFromUrl) {
      setDraft(null);
      setJob(null);
      return;
    }
    void loadDraft(draftIdFromUrl, { updateUrl: false });
  }, [draftIdFromUrl, loadDraft, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !shouldPersistSession || typeof window === "undefined") return;
    try {
      const stored: StoredInstagramCollectionSession = {
        draftIds: collectionDraftIds,
        activeDraftId: draftIdFromUrl ?? null,
        masterPublishJobId: collectionJobId,
        routeTitle: toNullableTrimmed(collectionTitle),
      };
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Ignore sessionStorage failures; the page still works in-memory.
    }
  }, [collectionDraftIds, collectionJobId, collectionTitle, draftIdFromUrl, sessionReady, shouldPersistSession]);

  useEffect(() => {
    if (!draft) {
      setTitleInput("");
      setScriptInput("");
      setPlaceQueryInput("");
      setSearchResults([]);
      return;
    }
    setTitleInput(draft.content.editedTitle || draft.content.generatedTitle || "");
    setScriptInput(draft.content.editedScript || draft.content.generatedScript || "");
    setPlaceQueryInput(preferredPlaceQuery(draft));
    setSearchResults(draft.location.suggestedPlace ? [draft.location.suggestedPlace] : []);
    storeDraft(draft);
  }, [draft, storeDraft]);

  useEffect(() => {
    if (!job || !isActiveJob(job)) return;
    let cancelled = false;
    const intervalId = window.setInterval(async () => {
      try {
        const nextJob = await fetchJson<InstagramImportJobResponse>(
          `/api/instagram-imports/jobs/${encodeURIComponent(job.id)}`
        );
        if (cancelled) return;
        setJob(nextJob);
        if (isTerminalJob(nextJob)) {
          const nextDraft = await loadDraft(nextJob.draftId, { updateUrl: false });
          if (!cancelled && nextDraft && nextJob.phase === "publish" && nextJob.status === "published") {
            setCollectionDraftIds((current) =>
              removeInstagramCollectionDraftId(current, nextDraft.id)
            );
          }
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Failed to poll job");
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [job, loadDraft]);

  useEffect(() => {
    if (!collectionJobId || (collectionJob && collectionJob.id === collectionJobId)) return;
    let cancelled = false;
    void fetchJson<InstagramImportJobResponse>(
      `/api/instagram-imports/jobs/${encodeURIComponent(collectionJobId)}`
    )
      .then((nextJob) => {
        if (!cancelled) setCollectionJob(nextJob);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setCollectionJobId(null);
          setCollectionJob(null);
          setError(loadError instanceof Error ? loadError.message : "Failed to load master publish job");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [collectionJob, collectionJobId]);

  useEffect(() => {
    if (!collectionJob || !isActiveJob(collectionJob)) return;
    let cancelled = false;
    const trackedDraftIds =
      (collectionDraftIds.length > 0 ? collectionDraftIds : restoredCollectionDraftIdsRef.current).slice();

    const intervalId = window.setInterval(async () => {
      try {
        const nextJob = await fetchJson<InstagramImportJobResponse>(
          `/api/instagram-imports/jobs/${encodeURIComponent(collectionJob.id)}`
        );
        if (cancelled) return;
        setCollectionJob(nextJob);
        if (isTerminalJob(nextJob)) {
          const refreshedDrafts = await refreshCollectionDrafts(trackedDraftIds);
          if (draftIdFromUrl && trackedDraftIds.includes(draftIdFromUrl)) {
            await loadDraft(draftIdFromUrl, { updateUrl: false, silent: true });
          }
          setCollectionJobId(null);
          if (nextJob.status === "published") {
            const publishedJamId = refreshedDrafts[0]?.publish.publishedJamId ?? null;
            const sharedPublishedRouteId = refreshedDrafts[0]?.publish.publishedRouteId ?? null;
            const hasSharedPublishResult =
              Boolean(publishedJamId && sharedPublishedRouteId) &&
              refreshedDrafts.length > 0 &&
              refreshedDrafts.every(
                (draft) =>
                  draft.publish.publishedJamId === publishedJamId &&
                  draft.publish.publishedRouteId === sharedPublishedRouteId
              );

            if (hasSharedPublishResult && publishedJamId) {
              setCollectionDraftIds([]);
              setCollectionTitle("");
              router.push(`/?jam=${encodeURIComponent(publishedJamId)}`);
            } else {
              setError("Master publish finished, but the published route could not be resolved from the refreshed drafts.");
            }
          }
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Failed to poll master publish job");
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [collectionDraftIds, collectionJob, draftIdFromUrl, loadDraft, refreshCollectionDrafts, router]);

  async function patchDraft(body: {
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
    if (!draft) return null;
    const updated = await fetchJson<InstagramDraftResponse>(
      `/api/instagram-imports/drafts/${encodeURIComponent(draft.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    setDraft(updated);
    setJob(updated.latestJob);
    storeDraft(updated);
    return updated;
  }

  async function handleCreateImport() {
    if (!urlInput.trim()) {
      setError("Paste a public Instagram reel or post URL.");
      return;
    }
    if (!canAddMoreStops) {
      setError(`You can add up to ${INSTAGRAM_COLLECTION_MAX_STOPS} stops per collection.`);
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      await persistActiveDraftEdits();
      const response = await fetchJson<CreateResponse>("/api/instagram-imports/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput }),
      });
      if (!response.draftId) {
        throw new Error("Draft ID was missing from the response.");
      }
      setShouldPersistSession(true);
      setCollectionDraftIds((current) =>
        addInstagramCollectionDraftId(current, response.draftId, INSTAGRAM_COLLECTION_MAX_STOPS)
      );
      await loadDraft(response.draftId);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to start import");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleSaveDraft() {
    if (!draft) return;
    setIsSaving(true);
    setError(null);
    try {
      await patchDraft({
        editedTitle: titleInput,
        editedScript: scriptInput,
        placeQuery: placeQueryInput,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save draft");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSearchPlaces() {
    if (!draft) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const response = await fetchJson<PlacesResponse>(
        `/api/instagram-imports/drafts/${encodeURIComponent(draft.id)}/places/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: placeQueryInput }),
        }
      );
      const candidates = response.candidates || [];
      setSearchResults(candidates);
      if (candidates.length === 0) {
        setSearchError("No matching places were found.");
      }
    } catch (placeError) {
      setSearchError(placeError instanceof Error ? placeError.message : "Failed to search places");
    } finally {
      setIsSearching(false);
    }
  }

  async function handleConfirmPlace(candidate: InstagramPlaceCandidate | null) {
    try {
      await patchDraft({
        placeQuery: placeQueryInput,
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

  async function handleSelectCollectionDraft(nextDraftId: string) {
    if (nextDraftId === draftIdFromUrl) return;
    try {
      await persistActiveDraftEdits();
      setShouldPersistSession(true);
      router.replace(`/import/instagram?draft=${encodeURIComponent(nextDraftId)}`);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Failed to switch draft");
    }
  }

  async function handleAddAnotherStop() {
    if (!canAddMoreStops) {
      setError(`You can add up to ${INSTAGRAM_COLLECTION_MAX_STOPS} stops per collection.`);
      return;
    }
    try {
      await persistActiveDraftEdits();
      setDraft(null);
      setJob(null);
      setUrlInput("");
      setTitleInput("");
      setScriptInput("");
      setPlaceQueryInput("");
      setSearchResults([]);
      setError(null);
      router.replace("/import/instagram");
    } catch (nextStopError) {
      setError(nextStopError instanceof Error ? nextStopError.message : "Failed to prepare the next stop");
    }
  }

  async function handleRemoveCollectionDraft(removedDraftId: string) {
    try {
      if (draft?.id === removedDraftId) {
        await persistActiveDraftEdits();
      }
      const nextDraftIds = removeInstagramCollectionDraftId(collectionDraftIds, removedDraftId);
      setCollectionDraftIds(nextDraftIds);
      setError(null);

      if (draftIdFromUrl === removedDraftId) {
        const nextActiveDraftId = nextDraftIds[0] || null;
        if (nextActiveDraftId) {
          router.replace(`/import/instagram?draft=${encodeURIComponent(nextActiveDraftId)}`);
        } else {
          setDraft(null);
          setJob(null);
          setUrlInput("");
          router.replace("/import/instagram");
        }
      }
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Failed to remove stop");
    }
  }

  async function handlePublish() {
    if (!draft) return;
    setIsPublishing(true);
    setError(null);
    try {
      await patchDraft({
        editedTitle: titleInput,
        editedScript: scriptInput,
        placeQuery: placeQueryInput,
      });
      const response = await fetchJson<PublishResponse>(
        `/api/instagram-imports/drafts/${encodeURIComponent(draft.id)}/publish`,
        { method: "POST" }
      );
      if (response.publishedJamId) {
        setCollectionDraftIds((current) => removeInstagramCollectionDraftId(current, draft.id));
        router.push(`/?jam=${encodeURIComponent(response.publishedJamId)}`);
        return;
      }
      if (!response.jobId) {
        throw new Error("Publish job metadata was missing.");
      }
      setJob({
        id: response.jobId,
        draftId: draft.id,
        phase: "publish",
        status: "queued",
        progress: 0,
        message: "Queued for publish",
        error: null,
        attempts: job?.attempts || 0,
        updatedAt: new Date().toISOString(),
      });
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Failed to publish draft");
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleMasterPublish() {
    if (collectionDraftIds.length === 0) {
      setError("Add at least one Instagram stop before master publish.");
      return;
    }

    setIsMasterPublishing(true);
    setError(null);
    try {
      const updatedDraft = await persistActiveDraftEdits();
      const draftSnapshots = collectionDraftIds.map((draftId) => {
        if (updatedDraft?.id === draftId) return updatedDraft;
        if (draft?.id === draftId) return draft;
        return collectionDrafts[draftId] ?? null;
      });

      if (!canMasterPublishInstagramDrafts(draftSnapshots, INSTAGRAM_COLLECTION_MAX_STOPS)) {
        throw new Error("Every stop must be ready with a confirmed location before master publish.");
      }

      const response = await fetchJson<PublishCollectionResponse>(
        "/api/instagram-imports/publish-collection",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftIds: collectionDraftIds,
            routeTitle: collectionTitle,
          }),
        }
      );

      if (response.publishedJamId) {
        setCollectionDraftIds([]);
        setCollectionTitle("");
        setCollectionJobId(null);
        router.push(`/?jam=${encodeURIComponent(response.publishedJamId)}`);
        return;
      }
      if (!response.jobId || !response.draftId) {
        throw new Error("Master publish job metadata was missing.");
      }

      const queuedJob: InstagramImportJobResponse = {
        id: response.jobId,
        draftId: response.draftId,
        phase: "publish_collection",
        status: "queued",
        progress: 0,
        message: "Queued for master publish",
        error: null,
        attempts: 0,
        updatedAt: new Date().toISOString(),
      };
      setCollectionJob(queuedJob);
      setCollectionJobId(response.jobId);
    } catch (publishError) {
      setError(
        publishError instanceof Error ? publishError.message : "Failed to queue master publish"
      );
    } finally {
      setIsMasterPublishing(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <Link href="/" className={styles.backLink}>
              Back to EchoJam
            </Link>
            <h1 className={styles.title}>Import from Instagram</h1>
            <p className={styles.subtitle}>
              Build a multi-stop route from public Instagram reels and posts. Add up to {INSTAGRAM_COLLECTION_MAX_STOPS} stops in one session, then master publish the full collection as a single custom route.
            </p>
          </div>
          <div className={styles.badge}>Session collection flow</div>
        </header>

        <section className={styles.card}>
          <div className={styles.formRow}>
            <input
              type="url"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              className={styles.textInput}
              placeholder="https://www.instagram.com/reels/..."
              aria-label="Instagram URL"
            />
            <button
              type="button"
              onClick={() => void handleCreateImport()}
              disabled={isCreating || !canAddMoreStops}
              className={styles.primaryButton}
            >
              {isCreating ? "Starting..." : "Start import"}
            </button>
          </div>
          {!canAddMoreStops ? (
            <div className={styles.warningBanner}>
              This collection is full. Master publish it or remove a stop to add another.
            </div>
          ) : null}
          {error ? <div className={styles.errorBanner}>{error}</div> : null}
        </section>

        <section className={`${styles.card} ${styles.collectionCard}`}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.metaLabel}>Collection</div>
              <h2 className={styles.sectionTitle}>
                {collectionDraftIds.length}/{INSTAGRAM_COLLECTION_MAX_STOPS} stops
              </h2>
            </div>
            <button
              type="button"
              onClick={() => void handleAddAnotherStop()}
              disabled={!canAddMoreStops || Boolean(activeJob)}
              className={styles.secondaryButton}
            >
              Add another stop
            </button>
          </div>

          <label className={styles.fieldLabel}>
            Route title
            <input
              type="text"
              value={collectionTitle}
              onChange={(event) => setCollectionTitle(event.target.value)}
              className={styles.textInput}
              placeholder="Optional master route title"
            />
          </label>

          {activeCollectionJob || collectionJob?.status === "failed" ? (
            <div className={styles.collectionJobCard}>
              <div className={styles.statusHeader}>
                <div>
                  <div className={styles.metaLabel}>{formatJobLabel(collectionJob)}</div>
                  <h3 className={styles.collectionJobTitle}>{formatHeading(collectionJob)}</h3>
                </div>
                <div className={styles.progressValue}>{collectionJob?.progress ?? 0}%</div>
              </div>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${collectionJob?.progress ?? 0}%` }} />
              </div>
              <div className={styles.statusMessage}>
                {collectionJob?.error || collectionJob?.message || "Queued"}
              </div>
            </div>
          ) : null}

          <div className={styles.collectionList}>
            {collectionDraftIds.length === 0 ? (
              <div className={styles.emptyState}>
                Import your first Instagram stop to start a collection.
              </div>
            ) : (
              collectionDraftIds.map((draftId, index) => {
                const collectionDraft = collectionEntries[index];
                const status = collectionDraft
                  ? getInstagramCollectionDraftStatus(collectionDraft)
                  : "importing";
                const isSelected = draftIdFromUrl === draftId;

                return (
                  <div
                    key={draftId}
                    className={`${styles.collectionRow} ${isSelected ? styles.collectionRowActive : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => void handleSelectCollectionDraft(draftId)}
                      className={styles.collectionSelect}
                    >
                      <div className={styles.collectionIndex}>{index + 1}</div>
                      <div className={styles.collectionCopy}>
                        <div className={styles.collectionTitle}>
                          {summarizeCollectionDraft(collectionDraft, draftId)}
                        </div>
                        <div className={styles.collectionMeta}>
                          {describeCollectionDraft(collectionDraft)}
                        </div>
                      </div>
                    </button>
                    <div className={styles.collectionActions}>
                      <span
                        className={`${styles.collectionStatus} ${styles[`status${status}`]}`}
                      >
                        {formatCollectionStatusLabel(status)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleRemoveCollectionDraft(draftId)}
                        className={styles.linkButton}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className={styles.collectionFooter}>
            <div className={styles.publishNote}>
              {canMasterPublish
                ? "All stops are ready for Master Publish."
                : "Each stop must finish importing and have a confirmed location before Master Publish."}
            </div>
            <button
              type="button"
              onClick={() => void handleMasterPublish()}
              disabled={isMasterPublishing || Boolean(activeCollectionJob) || !canMasterPublish}
              className={styles.primaryButton}
            >
              {isMasterPublishing ? "Queueing..." : "Master Publish"}
            </button>
          </div>
        </section>

        {activeJob ? (
          <section className={`${styles.card} ${styles.statusCard}`}>
            <div className={styles.statusHeader}>
              <div>
                <div className={styles.metaLabel}>{formatJobLabel(activeJob)}</div>
                <h2 className={styles.sectionTitle}>{formatHeading(activeJob)}</h2>
              </div>
              <div className={styles.progressValue}>{activeJob.progress}%</div>
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${activeJob.progress}%` }} />
            </div>
            <div className={styles.statusMessage}>{activeJob.message}</div>
          </section>
        ) : null}

        {draft ? (
          <div className={styles.grid}>
            <section className={styles.card}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Source</h2>
                <span className={styles.metaLabel}>{draft.source.kind === "reel" ? "Reel" : "Post"}</span>
              </div>
              {draft.source.thumbnailUrl ? (
                <div className={styles.preview}>
                  <Image
                    src={draft.source.thumbnailUrl}
                    alt=""
                    fill
                    unoptimized
                    className={styles.previewImage}
                  />
                </div>
              ) : null}
              <div className={styles.copyBlock}>
                <div><span className={styles.metaLabel}>Owner</span> {draft.source.ownerTitle || "Unknown creator"}</div>
                <div><span className={styles.metaLabel}>Shortcode</span> {draft.source.shortcode}</div>
                <div><span className={styles.metaLabel}>Extracted text est.</span> {formatTokenEstimate(draft.metrics.extractedTextTokensEstimate)}</div>
                <div><span className={styles.metaLabel}>Cleaned text est.</span> {formatTokenEstimate(draft.metrics.cleanedTextTokensEstimate)}</div>
              </div>
              {draft.warning ? <div className={styles.warningBanner}>{draft.warning}</div> : null}
              {draft.source.caption ? (
                <div className={styles.captionBlock}>
                  <div className={styles.metaLabel}>Caption</div>
                  <p>{draft.source.caption}</p>
                </div>
              ) : null}
            </section>

            <section className={styles.card}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Draft editor</h2>
                {isLoadingDraft ? <span className={styles.metaLabel}>Refreshing</span> : null}
              </div>
              <label className={styles.fieldLabel}>
                Title
                <input
                  type="text"
                  value={titleInput}
                  onChange={(event) => setTitleInput(event.target.value)}
                  className={styles.textInput}
                />
              </label>
              <label className={styles.fieldLabel}>
                Script
                <textarea
                  value={scriptInput}
                  onChange={(event) => setScriptInput(event.target.value)}
                  rows={12}
                  className={styles.textarea}
                />
              </label>
              <div className={styles.actionRow}>
                <button
                  type="button"
                  onClick={() => void handleSaveDraft()}
                  disabled={isSaving}
                  className={styles.secondaryButton}
                >
                  {isSaving ? "Saving..." : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => void handlePublish()}
                  disabled={isPublishing || !draft.location.publishReady}
                  className={styles.primaryButton}
                >
                  {isPublishing ? "Publishing..." : "Publish to EchoJam"}
                </button>
              </div>
              <div className={styles.publishNote}>
                {draft.location.publishReady
                  ? "Ready to publish as a single-stop route."
                  : "Confirm a location to enable publish."}
              </div>
              {publishedJamId ? (
                <Link href={`/?jam=${encodeURIComponent(publishedJamId)}`} className={styles.openLink}>
                  Open published tour
                </Link>
              ) : null}
              {job?.status === "failed" ? (
                <div className={styles.errorBanner}>{job.error || "The last job failed."}</div>
              ) : null}
            </section>

            <section className={`${styles.card} ${styles.locationCard}`}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Location confirmation</h2>
                <span className={styles.metaLabel}>Required</span>
              </div>
              <div className={styles.formRow}>
                <input
                  type="text"
                  value={placeQueryInput}
                  onChange={(event) => setPlaceQueryInput(event.target.value)}
                  className={styles.textInput}
                  placeholder="Search a place"
                />
                <button
                  type="button"
                  onClick={() => void handleSearchPlaces()}
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
                    {confirmedPlace.formattedAddress ? <div>{confirmedPlace.formattedAddress}</div> : null}
                  </div>
                  <button type="button" onClick={() => void handleConfirmPlace(null)} className={styles.linkButton}>
                    Clear
                  </button>
                </div>
              ) : suggestedPlace ? (
                <button
                  type="button"
                  onClick={() => void handleConfirmPlace(suggestedPlace)}
                  className={styles.suggestedButton}
                >
                  Use suggested place: {suggestedPlace.label}
                </button>
              ) : null}

              <div className={styles.placeList}>
                {searchResults.map((candidate) => (
                  <button
                    key={`${candidate.googlePlaceId || `${candidate.lat},${candidate.lng}`}`}
                    type="button"
                    onClick={() => void handleConfirmPlace(candidate)}
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
            </section>
          </div>
        ) : (
          <div className={styles.footerActions}>
            <div className={styles.emptyState}>
              Select a stop from the collection or start a new Instagram import.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
