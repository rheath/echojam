"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  safeGetSupabaseUser,
  safeOnSupabaseAuthStateChange,
} from "@/lib/supabaseClient";
import {
  buildMixedImportJourneysPath,
  buildMixedImportPath,
} from "@/lib/mixedImportRouting";
import {
  type CreatorAccessStatusResponse,
  type OwnedMixedJourneySummary,
  type OwnedMixedJourneysResponse,
  type ResumeMixedJourneyResponse,
  fetchJson,
} from "../clientShared";
import styles from "../MixedComposerClient.module.css";

export default function MixedJourneysListClient() {
  const router = useRouter();
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [hasCreatorAccess, setHasCreatorAccess] = useState(false);
  const [isCheckingCreatorAccess, setIsCheckingCreatorAccess] = useState(false);
  const [creatorCode, setCreatorCode] = useState("");
  const [magicLinkEmail, setMagicLinkEmail] = useState("");
  const [magicLinkMessage, setMagicLinkMessage] = useState<string | null>(null);
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);
  const [ownedJourneys, setOwnedJourneys] = useState<OwnedMixedJourneySummary[]>([]);
  const [isLoadingOwnedJourneys, setIsLoadingOwnedJourneys] = useState(false);
  const [isResumingOwnedJourney, setIsResumingOwnedJourney] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function syncAuth() {
      const data = await safeGetSupabaseUser(undefined, {
        context: "mixed journeys user",
      });
      if (cancelled) return;
      setAuthEmail(data?.email?.trim() || null);
      setIsAuthReady(true);
    }

    void syncAuth();
    const subscription = safeOnSupabaseAuthStateChange(() => {
      void syncAuth();
    }, undefined, {
      context: "mixed journeys auth subscription",
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isAuthReady) return;
    if (!authEmail) {
      setHasCreatorAccess(false);
      return;
    }

    let cancelled = false;

    async function loadCreatorAccess() {
      setIsCheckingCreatorAccess(true);
      try {
        const response = await fetchJson<CreatorAccessStatusResponse>("/api/creator-access/status?scope=mixed");
        if (cancelled) return;
        setHasCreatorAccess(Boolean(response.authorized));
      } catch (loadError) {
        if (cancelled) return;
        setHasCreatorAccess(false);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to verify your creator access."
        );
      } finally {
        if (!cancelled) {
          setIsCheckingCreatorAccess(false);
        }
      }
    }

    void loadCreatorAccess();
    return () => {
      cancelled = true;
    };
  }, [authEmail, isAuthReady]);

  useEffect(() => {
    if (!isAuthReady || !authEmail || !hasCreatorAccess) return;
    let cancelled = false;

    async function loadOwnedJourneys() {
      setIsLoadingOwnedJourneys(true);
      try {
        const response = await fetchJson<OwnedMixedJourneysResponse>("/api/mixed-composer-jams");
        if (cancelled) return;
        const journeys = Array.isArray(response.journeys) ? response.journeys : [];
        setOwnedJourneys(journeys);
        if (journeys.length === 0) {
          router.replace(buildMixedImportPath());
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load your creator journeys."
        );
      } finally {
        if (!cancelled) {
          setIsLoadingOwnedJourneys(false);
        }
      }
    }

    void loadOwnedJourneys();
    return () => {
      cancelled = true;
    };
  }, [authEmail, hasCreatorAccess, isAuthReady, router]);

  async function startCreatorAccess() {
    const normalizedCode = creatorCode.trim();
    const email = magicLinkEmail.trim().toLowerCase();
    if (!normalizedCode) {
      setError("Enter your creator code.");
      return;
    }
    if (!email) {
      setError("Enter the creator email for this journey.");
      return;
    }

    setError(null);
    setMagicLinkMessage(null);
    setIsSendingMagicLink(true);
    try {
      await fetchJson<{ ok: boolean }>("/api/creator-access/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: normalizedCode,
          email,
          next:
            typeof window === "undefined"
              ? buildMixedImportJourneysPath()
              : `${window.location.pathname}${window.location.search}`,
          scope: "mixed",
        }),
      });
      setMagicLinkMessage(
        "Check your inbox for a private Wandrful sign-in link. It expires in 5 minutes."
      );
    } catch (magicLinkError) {
      setError(
        magicLinkError instanceof Error
          ? magicLinkError.message
          : "Failed to send your magic link."
      );
    } finally {
      setIsSendingMagicLink(false);
    }
  }

  async function resumeOwnedJourney(jamId: string) {
    setError(null);
    setIsResumingOwnedJourney(true);
    try {
      const response = await fetchJson<ResumeMixedJourneyResponse>(
        `/api/mixed-composer-jams/${encodeURIComponent(jamId)}/resume`,
        {
          method: "POST",
        }
      );
      if (!response.sessionId) {
        throw new Error(response.error || "Failed to reopen your journey.");
      }
      router.replace(buildMixedImportPath({ sessionId: response.sessionId }));
    } catch (resumeError) {
      setError(
        resumeError instanceof Error
          ? resumeError.message
          : "Failed to reopen your journey."
      );
    } finally {
      setIsResumingOwnedJourney(false);
    }
  }

  if (!isAuthReady || (authEmail && isCheckingCreatorAccess)) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.card}>
            <h1 className={styles.title}>Your journeys</h1>
            <p className={styles.emptyState}>Checking your creator access...</p>
          </section>
        </div>
      </main>
    );
  }

  if (!authEmail || !hasCreatorAccess) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.card}>
            <h1 className={styles.title}>Claim creator access</h1>
            <p className={styles.emptyState}>
              Enter your creator code and email. We&apos;ll send a private magic link that unlocks only your journeys.
            </p>
            <div className={styles.inlineRow}>
              <input
                value={creatorCode}
                onChange={(event) => setCreatorCode(event.target.value)}
                placeholder="Creator code"
                type="text"
                autoComplete="one-time-code"
              />
              <input
                value={magicLinkEmail}
                onChange={(event) => setMagicLinkEmail(event.target.value)}
                placeholder="you@example.com"
                type="email"
                autoComplete="email"
              />
              <button type="button" onClick={() => void startCreatorAccess()} disabled={isSendingMagicLink}>
                {isSendingMagicLink ? "Sending..." : "Send magic link"}
              </button>
            </div>
            {authEmail && !hasCreatorAccess ? (
              <p className={styles.statusCopy}>
                Signed in as {authEmail}. Enter the invite code for this creator account to unlock editing.
              </p>
            ) : null}
            {magicLinkMessage ? <p className={styles.statusCopy}>{magicLinkMessage}</p> : null}
            {error ? <div className={styles.errorBanner}>{error}</div> : null}
          </section>
        </div>
      </main>
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
            <h1 className={styles.title}>Your journeys</h1>
            <p className={styles.subtitle}>
              Reopen an existing journey into a private draft, or start a brand-new one.
            </p>
          </div>
          <Link href={buildMixedImportPath()} className={`${styles.primaryButton} ${styles.linkButton} ${styles.bigCreateButton}`}>
            Create a new journey
          </Link>
        </div>

        <section className={styles.card}>
          <div className={styles.listHeader}>
            <h2 className={styles.sectionTitle}>Your creator journeys</h2>
          </div>
          {isLoadingOwnedJourneys ? (
            <p className={styles.emptyState}>Loading your journeys...</p>
          ) : (
            <div className={styles.results}>
              {ownedJourneys.map((journey) => (
                <button
                  key={journey.jamId}
                  type="button"
                  className={styles.resultRow}
                  onClick={() => void resumeOwnedJourney(journey.jamId)}
                  disabled={isResumingOwnedJourney}
                >
                  <div>
                    <div className={styles.resultTitle}>{journey.title}</div>
                    <div className={styles.placeAddress}>
                      {journey.hasDraft ? "Private draft ready" : "Reopen live journey into a private draft"}
                    </div>
                  </div>
                  <span className={styles.resultMeta}>Edit</span>
                </button>
              ))}
            </div>
          )}
          {error ? <div className={styles.errorBanner}>{error}</div> : null}
        </section>
      </div>
    </main>
  );
}
