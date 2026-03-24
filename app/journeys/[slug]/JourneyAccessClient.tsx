"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import WalkScreen from "@/app/components/WalkScreen";
import walkStyles from "@/app/components/WalkScreen.module.css";
import { supabase } from "@/lib/supabaseClient";
import { buildPathWithUtm, pickUtmParamsFromSearchParams, appendUtmParams } from "@/lib/utm";

const RouteMap = dynamic(() => import("@/app/components/RouteMap"), { ssr: false });

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

type JourneyStopPreview = {
  stop_id: string;
  title: string;
  lat?: number;
  lng?: number;
  image_url: string | null;
  position: number;
  is_overview?: boolean;
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

function buildJourneyOpenHref(sourceId: string, utmParams: ReturnType<typeof pickUtmParamsFromSearchParams>) {
  const searchParams = new URLSearchParams();
  searchParams.set("startPresetRoute", sourceId);
  appendUtmParams(searchParams, utmParams);
  const query = searchParams.toString();
  return query ? `/?${query}` : "/";
}

const MAGIC_LINK_SUCCESS_MESSAGE =
  "Check your inbox for a private Wandrful sign-in link from Wandrful Support. It expires in 5 minutes.";

export default function JourneyAccessClient({ slug, initialTeaser }: JourneyAccessClientProps) {
  const router = useRouter();
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
  const [isRedirectingToWalk, setIsRedirectingToWalk] = useState(false);
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
  const utmParams = useMemo(() => pickUtmParamsFromSearchParams(searchParams), [searchParams]);
  const journeyReturnPath = useMemo(() => buildPathWithUtm(`/journeys/${slug}`, utmParams), [slug, utmParams]);
  const grantedSourceId =
    payload?.access === "granted"
      ? payload.teaser?.sourceKind === "preset"
        ? payload.teaser.sourceId
        : initialTeaser.sourceKind === "preset"
          ? initialTeaser.sourceId
          : null
      : null;
  const openJourneyHref = grantedSourceId ? buildJourneyOpenHref(grantedSourceId, utmParams) : null;
  const isGranted = payload?.access === "granted";

  useEffect(() => {
    if (!isGranted || !openJourneyHref) return;
    setIsRedirectingToWalk(true);
    router.replace(openJourneyHref);
  }, [isGranted, openJourneyHref, router]);

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

  const mapStops = useMemo(
    () =>
      stopPreviews
        .filter((stop): stop is JourneyStopPreview & { lat: number; lng: number } => typeof stop.lat === "number" && typeof stop.lng === "number")
        .map((stop) => ({
          id: stop.stop_id,
          title: stop.title,
          lat: stop.lat,
          lng: stop.lng,
          images: stop.image_url ? [stop.image_url] : [],
        })),
    [stopPreviews]
  );

  const walkStops = useMemo(
    () =>
      stopPreviews.map((stop, index) => ({
        id: stop.stop_id,
        title: `${index + 1}. ${stop.title}`,
        subtitle: index === 0 ? "First stop" : `Stop ${index + 1}`,
        imageSrc: stop.image_url,
        isActive: index === 0,
      })),
    [stopPreviews]
  );
  const featuredStop = walkStops[0] ?? null;
  const remainingStops = walkStops.slice(1);

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
      <div className={walkStyles.overlayIntro}> 
        {teaser.teaserDescription ? (
          <p className={walkStyles.actionTitle}><strong>Unlock to listen to:</strong> {teaser.teaserDescription}</p>
        ) : null}
        
      </div>
    );
  }

  function renderActionPanel() {
    if (isGranted) {
      return openJourneyHref ? (
        <div className={walkStyles.unlockCard}>
          <div>
            <p className={walkStyles.actionTitle}>Journey unlocked</p>
            <p className={walkStyles.actionText}>Redirecting you into the full walk now.</p>
          </div>
        </div>
      ) : (
        <div className={walkStyles.unlockCard}>
          <div>
            <p className={walkStyles.actionTitle}>Journey unlocked</p>
            <p className={walkStyles.actionText}>
              This journey is unlocked for {userEmail || "your account"}.
            </p>
          </div>
        </div>
      );
    }

    if (userEmail) {
      return (
        <div className={walkStyles.unlockCard}>
          {renderLockedOverlayIntro()}
          <div className={walkStyles.overlayMetaBlock}>
            <p className={walkStyles.actionText}>
              Signed in as {userEmail}. Unlock the full walk to open every stop in EchoJam.
            </p>
          </div>
          <div className={walkStyles.buttonRow}>
            <button
              type="button"
              onClick={() => {
                void handleStartCheckout();
              }}
              disabled={isStartingCheckout}
              className={walkStyles.primaryButton}
            >
              {isStartingCheckout ? "Opening checkout..." : `Unlock for ${teaser.pricing.displayLabel}`}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleSignOut();
              }}
              className={walkStyles.secondaryButton}
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
      <form onSubmit={handleSendMagicLink} className={walkStyles.unlockCard}>
        {renderLockedOverlayIntro()}
        <label htmlFor="journey-email" className={walkStyles.actionLabel}>
          Enter email address to unlock journey
          <input
            id="journey-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            disabled={isSendingMagicLink}
            className={walkStyles.input}
          />
        </label>
        <button type="submit" disabled={isSendingMagicLink} className={walkStyles.primaryButton}>
          {isSendingMagicLink ? "Sending email..." : "Get started"}
        </button>
      </form>
    );
  }

  function renderStatusContent() {
    return (
      <>
        {magicLinkMessage ? (
          <div className={walkStyles.statusMessage}>
            {magicLinkMessage}{" "}
            <button
              type="button"
              className={walkStyles.inlineResetLink}
              onClick={() => {
                setMagicLinkMessage(null);
                setError(null);
              }}
            >
              Need another link?
            </button>
          </div>
        ) : null}
        {message ? <div className={walkStyles.statusMessage}>{message}</div> : null}
        {error ? <div className={walkStyles.statusError}>{error}</div> : null}
        {isLoading ? <div className={walkStyles.loadingState}>Checking access...</div> : null}
      </>
    );
  }

  function renderRailModal() {
    return (
      <div className={walkStyles.statusStack}>
        {renderStatusContent()}
        {renderActionPanel()}
      </div>
    );
  }

  function renderPageOverlay(): ReactNode {
    if (isStartingCheckout) {
      return (
        <div className={walkStyles.pageModalCard}>
          <p className={walkStyles.actionTitle}>Opening secure checkout</p>
          <p className={walkStyles.actionText}>
            We&apos;re taking you to our hosted payment screen now.
          </p>
        </div>
      );
    }

    if (isRedirectingToWalk) {
      return (
        <div className={walkStyles.pageModalCard}>
          <p className={walkStyles.actionTitle}>Journey unlocked</p>
          <p className={walkStyles.actionText}>Opening your full walk in EchoJam.</p>
        </div>
      );
    }

    return null;
  }

  return (
    <WalkScreen
      mode="locked"
      map={(
        <RouteMap
          stops={mapStops}
          currentStopIndex={0}
          initialFitRoute
          showRoutePath
          routeTravelMode="walk"
          interactive={false}
        />
      )}
      backControl={(
        <Link href="/" className={walkStyles.mapBackButton} aria-label="Back to EchoJam">
          <Image
            src="/icons/x.svg"
            alt=""
            width={26}
            height={26}
            className={walkStyles.mapBackIcon}
            aria-hidden="true"
          />
        </Link>
      )}
      metaRow={(
        <>
          <div className={walkStyles.walkNarratorAvatarWrap}>
            <Image
              src="/icons/stars.svg"
              alt=""
              width={24}
              height={24}
              className={walkStyles.walkNarratorIcon}
              aria-hidden="true"
            />
          </div>
          <div className={walkStyles.walkNarrator}>
            <span>Story by</span>
            <span className={walkStyles.walkNarratorActiveName}>{teaser.creatorLabel || "Wandrful"}</span>
          </div>
          <div className={walkStyles.metaPill}>{teaser.pricing.displayLabel}</div>
        </>
      )}
      title={teaser.title}
      subline={
        <>
          {durationLabel ? <span>{durationLabel}</span> : null}
          {stopCountLabel ? <span>{stopCountLabel}</span> : null}
        </>
      }
      stops={[]}
      featuredStop={featuredStop}
      remainingStops={remainingStops}
      blurRemainingStops={!isGranted && remainingStops.length > 0}
      stopsInteractive={false}
      railModal={!isGranted ? renderRailModal() : null}
      pageOverlay={renderPageOverlay()}
    />
  );
}
