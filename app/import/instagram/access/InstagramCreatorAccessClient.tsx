"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./InstagramCreatorAccessClient.module.css";

type AccessResponse = {
  ok?: boolean;
  error?: string;
};

async function submitCreatorCode(code: string) {
  const response = await fetch("/api/instagram-imports/access", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });

  const body = (await response.json().catch(() => ({}))) as AccessResponse;
  if (!response.ok) {
    throw new Error(body.error || "Failed to unlock Instagram uploader.");
  }

  return body;
}

export default function InstagramCreatorAccessClient() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await submitCreatorCode(code);
      router.replace("/import/instagram");
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
            <button
              type="submit"
              className={styles.submitButton}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Unlocking..." : "Unlock Instagram uploader"}
            </button>
          </form>

          {error ? <div className={styles.errorBanner}>{error}</div> : null}

          <p className={styles.helperCopy}>
            This unlock stays active on this browser for 30 days. Don't have a code? Reach out
          </p>
        </section>
      </div>
    </main>
  );
}
