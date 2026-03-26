"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { normalizeMixedImportNextPath } from "@/lib/mixedImportRouting";
import styles from "./TikTokCreatorAccessClient.module.css";

type AccessResponse = {
  ok?: boolean;
  error?: string;
};

export default function TikTokCreatorAccessClient() {
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nextPath = normalizeMixedImportNextPath(searchParams.get("next"), "tiktok");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/tiktok-imports/access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, email, next: nextPath }),
      });
      const body = (await response.json().catch(() => ({}))) as AccessResponse;
      if (!response.ok) {
        throw new Error(body.error || "Failed to unlock TikTok uploader.");
      }
      setMessage("Check your inbox for a private Wandrful sign-in link.");
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
            <label className={styles.fieldLabel} htmlFor="creator-email">
              Creator email
            </label>
            <input
              id="creator-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={styles.input}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={isSubmitting}
            />
            <button
              type="submit"
              className={styles.submitButton}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Sending..." : "Send magic link"}
            </button>
          </form>

          {error ? <div className={styles.errorBanner}>{error}</div> : null}
          {message ? <div className={styles.subtitle}>{message}</div> : null}
        </section>
      </div>
    </main>
  );
}
