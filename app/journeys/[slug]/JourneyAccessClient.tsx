"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { buildPathWithUtm, pickUtmParamsFromSearchParams } from "@/lib/utm";
import styles from "./JourneyAccessClient.module.css";

type JourneyOfferingSummary = {
  id: string;
  slug: string;
  title: string;
  creatorLabel: string | null;
  coverImageUrl: string | null;
  teaserDescription: string | null;
  durationMinutes: number | null;
  stopCount: number | null;
  firstStopTitle: string | null;
  pricing: {
    status: "free" | "paid" | "tbd";
    amountUsdCents: number | null;
    displayLabel: string;
  };
  sourceKind: "preset" | "custom";
  sourceId: string;
  published: boolean;
};

type JourneyApiResponse =
  | {
      access: "locked";
      teaser: JourneyOfferingSummary;
      previewStops: JourneyStopPreview[];
    }
  | {
      access: "granted";
      teaser: JourneyOfferingSummary | null;
      route: {
        title: string;
        length_minutes: number;
      };
      stops: JourneyStopPreview[];
    };

type JourneyStopPreview = {
  stop_id: string;
  title: string;
  image_url: string | null;
  position: number;
  is_overview?: boolean;
};

type JourneyAccessClientProps = {
  slug: string;
  initialTeaser: JourneyOfferingSummary;
};

async function withAuthHeaders() {
  const headers = new Headers();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token?.trim();
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return headers;
}

function buildFallbackStopPreview(teaser: JourneyOfferingSummary): JourneyStopPreview[] {
  if (!teaser.firstStopTitle) return [];
  return [
    {
      stop_id: "teaser-first-stop",
      title: teaser.firstStopTitle,
      image_url: teaser.coverImageUrl,
      position: 0,
      is_overview: false,
    },
  ];
}

const MAGIC_LINK_SUCCESS_MESSAGE =
  "Check your inbox for a private Wandrful sign-in link from Wandrful Support. It expires in 5 minutes.";

export default function JourneyAccessClient({ slug, initialTeaser }: JourneyAccessClientProps) {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [magicLinkMessage, setMagicLinkMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(() => {
    const checkoutStatus = (searchParams.get("checkout") || "").trim();
    if (checkoutStatus === "success") return "Payment received. Refreshing your access...";
    if (checkoutStatus === "cancelled") return "Checkout was cancelled.";
    return null;
  });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);
  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const [payload, setPayload] = useState<JourneyApiResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function syncUser() {
      const { data } = await supabase.auth.getUser();
      if (!cancelled) {
        setUserEmail(data.user?.email?.trim() || null);
      }
    }

    void syncUser();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void syncUser();
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadJourney() {
      setIsLoading(true);
      setError(null);
      try {
        const headers = await withAuthHeaders();
        const response = await fetch(`/api/journey-offerings/${encodeURIComponent(slug)}`, {
          cache: "no-store",
          headers,
        });
        const body = (await response.json().catch(() => ({}))) as JourneyApiResponse & { error?: string };
        if (!response.ok) {
          throw new Error(body.error || "Failed to load journey.");
        }
        if (!cancelled) {
          setPayload(body);
          if (body.access === "granted") {
            setMagicLinkMessage(null);
            setMessage("Journey unlocked.");
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load journey.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadJourney();
    return () => {
      cancelled = true;
    };
  }, [slug, userEmail]);

  const teaser = payload?.teaser ?? initialTeaser;
  const stopCountLabel = typeof teaser.stopCount === "number" ? `${teaser.stopCount} stops` : null;
  const durationLabel = typeof teaser.durationMinutes === "number" ? `${teaser.durationMinutes} mins` : null;
  const metadataLabel = [durationLabel, stopCountLabel].filter(Boolean).join(" • ");
  const utmParams = useMemo(() => pickUtmParamsFromSearchParams(searchParams), [searchParams]);
  const journeyReturnPath = useMemo(() => buildPathWithUtm(`/journeys/${slug}`, utmParams), [slug, utmParams]);
  const canOpenJourney =
    payload?.access === "granted" &&
    Boolean(payload.teaser?.sourceKind === "preset" && payload.teaser.sourceId);
  const openJourneyHref = canOpenJourney
    ? `/?startPresetRoute=${encodeURIComponent(payload!.teaser!.sourceId)}`
    : null;
  const hasHeroImage = Boolean(teaser.coverImageUrl?.trim());
  const isGranted = payload?.access === "granted";
  const stopPreviews = useMemo(() => {
    const fallbackStops = buildFallbackStopPreview(teaser);
    if (payload?.access === "granted") {
      return payload.stops.filter((stop) => !stop.is_overview);
    }
    if (payload?.access === "locked") {
      return payload.previewStops.filter((stop) => !stop.is_overview);
    }
    return fallbackStops;
  }, [payload, teaser]);
  const firstVisibleStop = stopPreviews[0] ?? null;
  const remainingStops = stopPreviews.slice(1);
  const shouldOverlayLockedStops = !isGranted && remainingStops.length > 0;

  async function handleSendMagicLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSendingMagicLink(true);
    setError(null);
    setMessage(null);
    setMagicLinkMessage(null);

    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          next: journeyReturnPath,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Failed to send magic link.");
      }
      setMagicLinkMessage(MAGIC_LINK_SUCCESS_MESSAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send magic link.");
    } finally {
      setIsSendingMagicLink(false);
    }
  }

  async function handleStartCheckout() {
    setIsStartingCheckout(true);
    setError(null);
    setMessage(null);
    setMagicLinkMessage(null);

    try {
      const headers = await withAuthHeaders();
      headers.set("Content-Type", "application/json");
      const response = await fetch(`/api/journey-offerings/${encodeURIComponent(slug)}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ utm: utmParams }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; url?: string | null };
      if (!response.ok || !body.url) {
        throw new Error(body.error || "Failed to start checkout.");
      }
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout.");
      setIsStartingCheckout(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUserEmail(null);
    setPayload(null);
    setMagicLinkMessage(null);
    setMessage("Signed out.");
  }

  function renderLockedOverlayIntro() {
    return (
      <div className={styles.overlayIntro}>
        <p className={styles.actionTitle}>Unlock this journey</p>
        {teaser.teaserDescription ? (
          <p className={styles.overlayQuote}>
            Step into the {teaser.teaserDescription}
          </p>
        ) : null}
        <p className={styles.actionText}>
          Enter your email to receive your private access link and continue the full journey.
        </p>
      </div>
    );
  }

  function renderActionPanel() {
    if (isGranted) {
      return (
        <div className={styles.actionCard}>
          <div>
            <p className={styles.actionTitle}>Journey unlocked</p>
            <p className={styles.actionText}>
              This journey is unlocked for {userEmail || "your account"}.
            </p>
          </div>
          {openJourneyHref ? (
            <Link href={openJourneyHref} className={styles.primaryLink}>
              Open in EchoJam
            </Link>
            ) : null}
        </div>
      );
    }

    if (userEmail) {
      return (
        <div className={styles.actionCard}>
          {renderLockedOverlayIntro()}
          <div className={styles.overlayMetaBlock}>
            <p className={styles.actionText}>
              Signed in as {userEmail}. Unlock the full walk to open every stop in EchoJam.
            </p>
          </div>
          <div className={styles.buttonRow}>
            <button
              type="button"
              onClick={() => {
                void handleStartCheckout();
              }}
              disabled={isStartingCheckout}
              className={styles.primaryButton}
            >
              {isStartingCheckout ? "Opening checkout..." : `Unlock for ${teaser.pricing.displayLabel}`}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleSignOut();
              }}
              className={styles.secondaryButton}
            >
              Sign out
            </button>
          </div>
        </div>
      );
    }

    if (magicLinkMessage) {
      return null;
    }

    return (
      <form onSubmit={handleSendMagicLink} className={styles.actionCard}>
        {renderLockedOverlayIntro()}
        <label htmlFor="journey-email" className={styles.actionLabel}>
          Email address
          <input
            id="journey-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            disabled={isSendingMagicLink}
            className={styles.input}
          />
        </label>
        <button type="submit" disabled={isSendingMagicLink} className={styles.primaryButton}>
          {isSendingMagicLink ? "Sending magic link..." : "Email me a magic link"}
        </button>
      </form>
    );
  }

  function renderStatusContent() {
    return (
      <>
        {magicLinkMessage ? (
          <div className={styles.statusMessage}>
            {magicLinkMessage}{" "}
            <button
              type="button"
              className={styles.inlineResetLink}
              onClick={() => {
                setMagicLinkMessage(null);
                setError(null);
              }}
            >
              Need another link?
            </button>
          </div>
        ) : null}
        {message ? <div className={styles.statusMessage}>{message}</div> : null}
        {error ? <div className={styles.statusError}>{error}</div> : null}
        {isLoading ? <div className={styles.loadingState}>Checking access...</div> : null}
      </>
    );
  }

  function renderStopRow(stop: JourneyStopPreview, index: number, options?: { highlight?: boolean }) {
    const stopNumber = index + 1;
    const subtitle = options?.highlight
      ? isGranted
        ? `Stop ${stopNumber}`
        : "First stop"
      : `Stop ${stopNumber}`;

    return (
      <div key={stop.stop_id} className={`${styles.stopItem} ${options?.highlight ? styles.stopItemHighlight : ""}`}>
        <div className={styles.stopThumbWrap}>
          {stop.image_url ? (
            <Image
              src={stop.image_url}
              alt={stop.title}
              fill
              className={styles.stopThumb}
              unoptimized
            />
          ) : null}
        </div>
        <div className={styles.stopText}>
          <div className={styles.stopSubtitle}>{subtitle}</div>
          <div className={`${styles.stopTitle} ${options?.highlight ? styles.stopTitleActive : ""}`}>
            {`${stopNumber}. ${stop.title}`}
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.layout}>
        <section className={`${styles.heroPane} ${hasHeroImage ? styles.heroPaneWithImage : ""}`}>
          {hasHeroImage ? (
            <Image
              src={teaser.coverImageUrl!}
              alt={teaser.title}
              fill
              priority
              className={styles.heroImage}
              unoptimized
            />
          ) : null}
          <Link href="/" className={styles.heroBackButton} aria-label="Back to EchoJam">
            <Image
              src="/icons/x.svg"
              alt=""
              width={26}
              height={26}
              className={styles.heroBackIcon}
              aria-hidden="true"
            />
          </Link>
        </section>

        <section className={styles.rail}>
          <div className={styles.railCard}>
            <div className={styles.metaRow}>
              <div className={styles.avatarWrap}>
                <Image
                  src="/icons/stars.svg"
                  alt=""
                  width={24}
                  height={24}
                  className={styles.avatarIcon}
                  aria-hidden="true"
                />
              </div>
              <div className={styles.metaText}>
                <span>Story by</span>
                <span className={styles.metaActiveName}>{teaser.creatorLabel || "Wandrful"}</span>
              </div>
              <div className={styles.pricePill}>{teaser.pricing.displayLabel}</div>
            </div>

            <h2 className={styles.headline}>{teaser.title}</h2>
            {metadataLabel ? <div className={styles.subline}>{metadataLabel}</div> : null}
            

            <section className={styles.stopSection}>
             

              {firstVisibleStop ? renderStopRow(firstVisibleStop, 0, { highlight: true }) : null}

              {remainingStops.length > 0 ? (
                shouldOverlayLockedStops ? (
                  <div className={styles.lockedStopsArea}>
                    <div className={styles.lockedStopsBlur} aria-hidden="true">
                      <div className={styles.stopList}>
                        {remainingStops.map((stop, index) => renderStopRow(stop, index + 1))}
                      </div>
                    </div>
                    <div className={styles.lockedOverlay}>
                      <div className={styles.lockedOverlayCard}>
                        <div className={styles.statusStack}>
                          {renderStatusContent()}
                          {renderActionPanel()}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className={styles.stopList}>
                    {remainingStops.map((stop, index) => renderStopRow(stop, index + 1))}
                  </div>
                )
              ) : null}
            </section>

            {!shouldOverlayLockedStops ? (
              <div className={styles.statusStack}>
                {renderStatusContent()}
                {renderActionPanel()}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
