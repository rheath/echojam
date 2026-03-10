"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  InstagramDraftResponse,
  InstagramImportJobResponse,
  InstagramPlaceCandidate,
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
  error?: string;
};

type PlacesResponse = {
  candidates?: InstagramPlaceCandidate[];
  error?: string;
};

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
  if (job.phase === "publish") return "Publishing to EchoJam";
  return job.status === "failed" ? "Import failed" : "Importing your post";
}

function formatTokenEstimate(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "Pending";
  return `~${value} tokens`;
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

  const activeJob = useMemo(() => (job && isActiveJob(job) ? job : null), [job]);
  const confirmedPlace = draft?.location.confirmedPlace || null;
  const suggestedPlace = draft?.location.suggestedPlace || null;
  const publishedJamId = draft?.publish.publishedJamId || null;

  const loadDraft = useCallback(async (draftId: string, opts?: { updateUrl?: boolean }) => {
    setIsLoadingDraft(true);
    try {
      const nextDraft = await fetchJson<InstagramDraftResponse>(
        `/api/instagram-imports/drafts/${encodeURIComponent(draftId)}`
      );
      setDraft(nextDraft);
      setJob(nextDraft.latestJob);
      setUrlInput(nextDraft.source.url);
      setError(null);
      if (opts?.updateUrl !== false) {
        router.replace(`/import/instagram?draft=${encodeURIComponent(draftId)}`);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load draft");
    } finally {
      setIsLoadingDraft(false);
    }
  }, [router]);

  useEffect(() => {
    if (!draftIdFromUrl) {
      setDraft(null);
      setJob(null);
      return;
    }
    void loadDraft(draftIdFromUrl, { updateUrl: false });
  }, [draftIdFromUrl, loadDraft]);

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
  }, [draft]);

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
          await loadDraft(nextJob.draftId);
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
    return updated;
  }

  async function handleCreateImport() {
    if (!urlInput.trim()) {
      setError("Paste a public Instagram reel or post URL.");
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const response = await fetchJson<CreateResponse>("/api/instagram-imports/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput }),
      });
      if (!response.draftId) {
        throw new Error("Draft ID was missing from the response.");
      }
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
              Paste one public Instagram reel or post URL. EchoJam will create a one-stop draft you can edit and publish.
            </p>
          </div>
          <div className={styles.badge}>Isolated import flow</div>
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
              disabled={isCreating}
              className={styles.primaryButton}
            >
              {isCreating ? "Starting..." : draft ? "Import again" : "Start import"}
            </button>
          </div>
          {error ? <div className={styles.errorBanner}>{error}</div> : null}
        </section>

        {activeJob ? (
          <section className={`${styles.card} ${styles.statusCard}`}>
            <div className={styles.statusHeader}>
              <div>
                <div className={styles.metaLabel}>{activeJob.phase === "publish" ? "Publish job" : "Import job"}</div>
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
                  ? "Ready to publish."
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
          <section className={styles.emptyState}>
            <div className={styles.card}>
              <h2 className={styles.sectionTitle}>How it works</h2>
              <p>
                EchoJam fetches the public page metadata, downloads media when possible, transcribes the audio, cleans the text, and creates a one-stop draft.
              </p>
              <p>
                You then edit the title and script, confirm the place, and publish it into the existing EchoJam listening experience.
              </p>
            </div>
          </section>
        )}

        {draft && !activeJob && !publishedJamId && (draft.status === "failed" || job?.status === "failed") ? (
          <div className={styles.footerActions}>
            <button type="button" onClick={() => void handleCreateImport()} className={styles.secondaryButton}>
              Retry import
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
