"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  safeGetSupabaseUser,
  safeOnSupabaseAuthStateChange,
} from "@/lib/supabaseClient";
import {
  buildMixedImportEntryPath,
  buildMixedImportJourneysPath,
  buildMixedImportPath,
} from "@/lib/mixedImportRouting";
import {
  type CreatorAccessStatusResponse,
  type OwnedMixedJourneysResponse,
  fetchJson,
} from "./clientShared";
import styles from "./MixedComposerClient.module.css";

export default function MixedImportEntryClient() {
  const router = useRouter();
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [hasCreatorAccess, setHasCreatorAccess] = useState(false);
  const [isCheckingCreatorAccess, setIsCheckingCreatorAccess] = useState(false);
  const [creatorCode, setCreatorCode] = useState("");
  const [magicLinkEmail, setMagicLinkEmail] = useState("");
  const [magicLinkMessage, setMagicLinkMessage] = useState<string | null>(null);
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);
  const [isLoadingOwnedJourneys, setIsLoadingOwnedJourneys] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRedirectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function syncAuth() {
      const data = await safeGetSupabaseUser(undefined, {
        context: "mixed import entry user",
      });
      if (cancelled) return;
      setAuthEmail(data?.email?.trim() || null);
      setIsAuthReady(true);
    }

    void syncAuth();
    const subscription = safeOnSupabaseAuthStateChange(() => {
      void syncAuth();
    }, undefined, {
      context: "mixed import entry auth subscription",
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
    if (!isAuthReady || !authEmail || !hasCreatorAccess || hasRedirectedRef.current) return;
    let cancelled = false;

    async function routeByOwnedJourneys() {
      setIsLoadingOwnedJourneys(true);
      try {
        const response = await fetchJson<OwnedMixedJourneysResponse>("/api/mixed-composer-jams");
        if (cancelled) return;
        hasRedirectedRef.current = true;
        router.replace(
          Array.isArray(response.journeys) && response.journeys.length > 0
            ? buildMixedImportJourneysPath()
            : buildMixedImportPath()
        );
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

    void routeByOwnedJourneys();
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
              ? buildMixedImportEntryPath()
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

  if (!isAuthReady || (authEmail && isCheckingCreatorAccess) || isLoadingOwnedJourneys) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.card}>
            <h1 className={styles.title}>Create your journey</h1>
            <p className={styles.emptyState}>
              {isLoadingOwnedJourneys ? "Loading your journeys..." : "Checking your creator access..."}
            </p>
          </section>
        </div>
      </main>
    );
  }

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
