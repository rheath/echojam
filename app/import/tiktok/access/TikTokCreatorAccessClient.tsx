"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./TikTokCreatorAccessClient.module.css";

type AccessResponse = {
  ok?: boolean;
  error?: string;
};

async function submitCreatorCode(code: string) {
  const response = await fetch("/api/tiktok-imports/access", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });

  const body = (await response.json().catch(() => ({}))) as AccessResponse;
  if (!response.ok) {
    throw new Error(body.error || "Failed to unlock TikTok uploader.");
  }

  return body;
}

export default function TikTokCreatorAccessClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nextPath = (() => {
    const candidate = searchParams.get("next");
    if (!candidate || !candidate.startsWith("/import/")) {
      return "/import/mixed?provider=tiktok";
    }
    return candidate;
  })();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await submitCreatorCode(code);
      router.replace(nextPath);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to unlock TikTok uploader."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <Link href="/" className={styles.backLink}>
          Back
        </Link>

        <section className={styles.card}>
          <h1 className={styles.title}>Unlock TikTok import</h1>
          <p className={styles.subtitle}>Enter your creator code to import TikTok videos into the mixed composer.</p>

          <form onSubmit={handleSubmit} className={styles.form}>
            <label className={styles.fieldLabel} htmlFor="creator-code">
              Creator code
            </label>
            <input
              id="creator-code"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={styles.input}
              autoComplete="one-time-code"
              disabled={isSubmitting}
            />
            <button
              type="submit"
              className={styles.submitButton}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Unlocking..." : "Unlock TikTok uploader"}
            </button>
          </form>

          {error ? <div className={styles.errorBanner}>{error}</div> : null}
        </section>
      </div>
    </main>
  );
}
