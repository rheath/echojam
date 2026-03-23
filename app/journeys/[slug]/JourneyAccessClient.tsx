"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

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
    }
  | {
      access: "granted";
      teaser: JourneyOfferingSummary | null;
      route: {
        title: string;
        length_minutes: number;
      };
      stops: Array<{
        stop_id: string;
        title: string;
      }>;
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

export default function JourneyAccessClient({ slug, initialTeaser }: JourneyAccessClientProps) {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
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
  const canOpenJourney =
    payload?.access === "granted" &&
    Boolean(payload.teaser?.sourceKind === "preset" && payload.teaser.sourceId);
  const openJourneyHref = canOpenJourney
    ? `/?startPresetRoute=${encodeURIComponent(payload!.teaser!.sourceId)}`
    : null;
  const stopPreviewTitles = useMemo(() => {
    if (payload?.access !== "granted") return [];
    return payload.stops.slice(0, 5).map((stop) => stop.title);
  }, [payload]);

  async function handleSendMagicLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSendingMagicLink(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          next: `/journeys/${slug}`,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Failed to send magic link.");
      }
      setMessage("Magic link sent. Open it from your email to continue.");
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

    try {
      const headers = await withAuthHeaders();
      headers.set("Content-Type", "application/json");
      const response = await fetch(`/api/journey-offerings/${encodeURIComponent(slug)}/checkout`, {
        method: "POST",
        headers,
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
    setMessage("Signed out.");
  }

  return (
    <main style={{ minHeight: "100vh", background: "#f6f2ea", color: "#17130e", padding: "32px 20px" }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <Link href="/" style={{ color: "#5f4c34", textDecoration: "none", fontWeight: 600 }}>
          Back to EchoJam
        </Link>

        <section
          style={{
            marginTop: 20,
            borderRadius: 28,
            overflow: "hidden",
            background: "#fffaf2",
            border: "1px solid rgba(60, 44, 24, 0.12)",
            boxShadow: "0 20px 50px rgba(54, 37, 14, 0.12)",
          }}
        >
          {teaser.coverImageUrl ? (
            <div
              style={{
                minHeight: 280,
                backgroundImage: `linear-gradient(rgba(20, 16, 12, 0.22), rgba(20, 16, 12, 0.48)), url("${teaser.coverImageUrl}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
            />
          ) : null}

          <div style={{ padding: 28 }}>
            <div style={{ display: "inline-block", padding: "8px 12px", borderRadius: 999, background: "#17130e", color: "#fffaf2", fontSize: 13, fontWeight: 700 }}>
              {teaser.pricing.displayLabel}
            </div>
            <h1 style={{ fontSize: "2.25rem", lineHeight: 1.05, margin: "16px 0 10px" }}>{teaser.title}</h1>
            {metadataLabel ? <p style={{ margin: "0 0 8px", color: "#69553b" }}>{metadataLabel}</p> : null}
            {teaser.creatorLabel ? <p style={{ margin: "0 0 16px", color: "#69553b" }}>Story by {teaser.creatorLabel}</p> : null}
            {teaser.teaserDescription ? <p style={{ margin: "0 0 16px", maxWidth: 640, fontSize: "1.05rem" }}>{teaser.teaserDescription}</p> : null}
            {teaser.firstStopTitle ? (
              <p style={{ margin: "0 0 20px", color: "#5f4c34" }}>
                First stop preview: <strong>{teaser.firstStopTitle}</strong>
              </p>
            ) : null}

            {message ? <div style={{ marginBottom: 12, color: "#1f6b35", fontWeight: 600 }}>{message}</div> : null}
            {error ? <div style={{ marginBottom: 12, color: "#a12d1f", fontWeight: 600 }}>{error}</div> : null}

            {isLoading ? <p style={{ margin: "0 0 12px" }}>Checking access...</p> : null}

            {payload?.access === "granted" ? (
              <div>
                <p style={{ margin: "0 0 16px", fontWeight: 600 }}>
                  This journey is unlocked for {userEmail || "your account"}.
                </p>
                {stopPreviewTitles.length > 0 ? (
                  <p style={{ margin: "0 0 16px", color: "#5f4c34" }}>
                    Included stops: {stopPreviewTitles.join(" • ")}
                    {payload.stops.length > stopPreviewTitles.length ? " • ..." : ""}
                  </p>
                ) : null}
                {openJourneyHref ? (
                  <Link
                    href={openJourneyHref}
                    style={{
                      display: "inline-block",
                      padding: "14px 18px",
                      borderRadius: 14,
                      background: "#17130e",
                      color: "#fffaf2",
                      textDecoration: "none",
                      fontWeight: 700,
                    }}
                  >
                    Open in EchoJam
                  </Link>
                ) : null}
              </div>
            ) : userEmail ? (
              <div>
                <p style={{ margin: "0 0 16px" }}>Signed in as {userEmail}</p>
                <button
                  type="button"
                  onClick={() => {
                    void handleStartCheckout();
                  }}
                  disabled={isStartingCheckout}
                  style={{
                    padding: "14px 18px",
                    borderRadius: 14,
                    border: "none",
                    background: "#17130e",
                    color: "#fffaf2",
                    fontWeight: 700,
                    cursor: isStartingCheckout ? "progress" : "pointer",
                  }}
                >
                  {isStartingCheckout ? "Opening checkout..." : `Unlock for ${teaser.pricing.displayLabel}`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleSignOut();
                  }}
                  style={{
                    marginLeft: 12,
                    padding: "14px 18px",
                    borderRadius: 14,
                    border: "1px solid rgba(60, 44, 24, 0.18)",
                    background: "transparent",
                    color: "#17130e",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <form onSubmit={handleSendMagicLink} style={{ display: "grid", gap: 12, maxWidth: 420 }}>
                <label htmlFor="journey-email" style={{ fontWeight: 600 }}>
                  Sign in with email to unlock this journey
                </label>
                <input
                  id="journey-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  disabled={isSendingMagicLink}
                  style={{
                    padding: "14px 16px",
                    borderRadius: 14,
                    border: "1px solid rgba(60, 44, 24, 0.18)",
                    fontSize: 16,
                  }}
                />
                <button
                  type="submit"
                  disabled={isSendingMagicLink}
                  style={{
                    padding: "14px 18px",
                    borderRadius: 14,
                    border: "none",
                    background: "#17130e",
                    color: "#fffaf2",
                    fontWeight: 700,
                    cursor: isSendingMagicLink ? "progress" : "pointer",
                  }}
                >
                  {isSendingMagicLink ? "Sending magic link..." : "Email me a magic link"}
                </button>
              </form>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
