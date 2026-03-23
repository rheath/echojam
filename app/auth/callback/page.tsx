"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

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
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        }
        if (!cancelled) {
          router.replace(nextPath);
        }
      } catch (e) {
        if (!cancelled) {
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
