"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  exchangeSupabaseCodeForSession,
  isSupabaseLockAcquireTimeoutError,
  retrySupabaseAuthOperation,
  supabase,
} from "@/lib/supabaseClient";

function normalizeNextPath(value: string | null) {
  const candidate = (value || "").trim();
  if (!candidate.startsWith("/")) return "/";
  if (candidate.startsWith("//")) return "/";
  return candidate;
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState("Signing you in...");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const code = (searchParams.get("code") || "").trim();
      const nextPath = normalizeNextPath(searchParams.get("next"));
      const errorDescription = (searchParams.get("error_description") || "").trim();
      if (errorDescription) {
        setMessage(errorDescription);
        return;
      }

      try {
        if (code) {
          const { error } = await exchangeSupabaseCodeForSession(code, undefined, {
            context: "auth callback exchange",
            retries: 2,
            retryDelayMs: 250,
          });
          if (error) throw error;
        }
        const session = await retrySupabaseAuthOperation(async () => {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          return session;
        }, {
          context: "auth callback getSession",
          retries: 2,
          retryDelayMs: 250,
        });
        const accessToken = session?.access_token?.trim();
        if (accessToken) {
          const response = await fetch("/api/creator-access/complete", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          });
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          if (!response.ok) {
            throw new Error(body.error || "Failed to finish creator sign-in.");
          }
        }
        if (!cancelled) {
          router.replace(nextPath);
        }
      } catch (e) {
        if (!cancelled) {
          if (isSupabaseLockAcquireTimeoutError(e)) {
            setMessage("We couldn't finish sign-in because browser session access is temporarily busy. Please retry in a moment.");
            return;
          }
          setMessage(e instanceof Error ? e.message : "Sign-in failed.");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif", lineHeight: 1.5 }}>
      <h1 style={{ fontSize: "1.25rem", margin: "0 0 8px" }}>Wandrful sign-in</h1>
      <p style={{ margin: 0 }}>{message}</p>
    </main>
  );
}
