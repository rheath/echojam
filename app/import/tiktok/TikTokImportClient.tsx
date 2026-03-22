"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./TikTokImportClient.module.css";

type CreateResponse = {
  draftId?: string;
  jobId?: string;
  error?: string;
};

type JobResponse = {
  status: "queued" | "processing" | "draft_ready" | "failed";
  error: string | null;
};

async function fetchJson<T>(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

export default function TikTokImportClient() {
  const router = useRouter();
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  async function handleImport() {
    if (!urlInput.trim()) {
      setError("Enter a TikTok video URL.");
      return;
    }

    setIsImporting(true);
    setError(null);
    setStatus("Starting import...");

    try {
      const create = await fetchJson<CreateResponse>("/api/tiktok-imports/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      if (!create.draftId || !create.jobId) {
        throw new Error("TikTok import job metadata was missing.");
      }

      for (let attempt = 0; attempt < 45; attempt += 1) {
        const job = await fetchJson<JobResponse>(
          `/api/tiktok-imports/jobs/${encodeURIComponent(create.jobId)}`
        );
        if (job.status === "draft_ready") {
          router.push(`/import/mixed?tiktokDraft=${encodeURIComponent(create.draftId)}`);
          return;
        }
        if (job.status === "failed") {
          throw new Error(job.error || "TikTok import failed.");
        }
        setStatus("Importing and preparing your TikTok stop...");
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      throw new Error("Timed out waiting for the TikTok draft.");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Failed to import TikTok stop.");
      setStatus(null);
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <Link href="/" className={styles.backLink}>Back</Link>
            <h1 className={styles.title}>Import from TikTok</h1>
            <p className={styles.subtitle}>
              Import one public TikTok video, then jump straight into the mixed composer with that draft preloaded.
            </p>
          </div>
          <Link href="/import/mixed?provider=tiktok" className={styles.secondaryLink}>
            Open Mixed Composer
          </Link>
        </header>

        <section className={styles.card}>
          <label className={styles.fieldLabel}>
            TikTok video URL
            <input
              type="url"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              className={styles.textInput}
              placeholder="https://www.tiktok.com/@creator/video/..."
            />
          </label>

          <div className={styles.actions}>
            <button type="button" onClick={() => void handleImport()} disabled={isImporting} className={styles.primaryButton}>
              {isImporting ? "Importing..." : "Import and open composer"}
            </button>
          </div>

          {status ? <div className={styles.statusBanner}>{status}</div> : null}
          {error ? <div className={styles.errorBanner}>{error}</div> : null}
        </section>
      </div>
    </main>
  );
}
