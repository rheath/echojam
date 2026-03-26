"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { normalizeMixedImportNextPath } from "@/lib/mixedImportRouting";
import styles from "./InstagramCreatorAccessClient.module.css";

type AccessResponse = {
  ok?: boolean;
  error?: string;
};

export default function InstagramCreatorAccessClient() {
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nextPath = normalizeMixedImportNextPath(searchParams.get("next"), "instagram");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/instagram-imports/access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, email, next: nextPath }),
      });
      const body = (await response.json().catch(() => ({}))) as AccessResponse;
      if (!response.ok) {
        throw new Error(body.error || "Failed to unlock Instagram uploader.");
      }
      setMessage("Check your inbox for a private Wandrful sign-in link.");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to unlock Instagram uploader."
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
          <h1 className={styles.title}>Welcome to Mix Stuido</h1>
           

          <form onSubmit={handleSubmit} className={styles.form}>
            <label className={styles.fieldLabel} htmlFor="creator-code">
              Enter your code to access
            </label>
            <input
              id="creator-code"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={styles.input}
              placeholder=""
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
          {message ? <div className={styles.helperCopy}>{message}</div> : null}

          <p className={styles.helperCopy}>
            Enter the invite code we gave you, then sign in from the email we send.
          </p>
        </section>
      </div>
    </main>
  );
}
