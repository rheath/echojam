import {
  estimateTextTokenCount,
  toNullableTrimmed,
  type InstagramPlaceCandidate,
} from "@/lib/instagramImport";

export type TikTokImportDraftStatus =
  | "pending_import"
  | "importing"
  | "draft_ready"
  | "failed";

export type TikTokImportJobPhase = "import";

export type TikTokImportJobStatus =
  | "queued"
  | "processing"
  | "draft_ready"
  | "failed";

export type TikTokImportJobResponse = {
  id: string;
  draftId: string;
  phase: TikTokImportJobPhase;
  status: TikTokImportJobStatus;
  progress: number;
  message: string;
  error: string | null;
  attempts: number;
  updatedAt: string;
};

export type TikTokDraftResponse = {
  id: string;
  status: TikTokImportDraftStatus;
  warning: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  source: {
    url: string;
    kind: "video";
    videoId: string | null;
    ownerTitle: string | null;
    ownerUserId: string | null;
    caption: string | null;
    thumbnailUrl: string | null;
  };
  content: {
    generatedTitle: string | null;
    generatedScript: string | null;
    editedTitle: string | null;
    editedScript: string | null;
    finalTitle: string | null;
    finalScript: string | null;
  };
  location: {
    placeQuery: string | null;
    cityHint: string | null;
    countryHint: string | null;
    confidence: number | null;
    suggestedPlace: InstagramPlaceCandidate | null;
    confirmedPlace: InstagramPlaceCandidate | null;
    publishReady: boolean;
  };
  metrics: {
    extractedTextTokensEstimate: number | null;
    cleanedTextTokensEstimate: number | null;
    finalScriptTokensEstimate: number | null;
  };
  latestJob: TikTokImportJobResponse | null;
};

export type TikTokDraftContent = {
  editedTitle?: string | null;
  editedScript?: string | null;
  generatedTitle?: string | null;
  generatedScript?: string | null;
  confirmedPlaceLabel?: string | null;
  confirmedPlaceLat?: number | null;
  confirmedPlaceLng?: number | null;
};

export type TikTokNormalizedUrl = {
  normalizedUrl: string;
  videoId: string | null;
};

export function normalizeTikTokUrl(rawUrl: string): TikTokNormalizedUrl | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const isSupportedHost =
    host === "tiktok.com" ||
    host === "www.tiktok.com" ||
    host === "m.tiktok.com" ||
    host === "vm.tiktok.com" ||
    host === "vt.tiktok.com";
  if (!isSupportedHost) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length >= 3 && segments[0]?.startsWith("@") && segments[1] === "video") {
    const videoId = toNullableTrimmed(segments[2]);
    if (!videoId || !/^\d+$/.test(videoId)) return null;
    return {
      normalizedUrl: `https://www.tiktok.com/${encodeURIComponent(segments[0])}/video/${videoId}`,
      videoId,
    };
  }

  return {
    normalizedUrl: parsed.toString(),
    videoId: null,
  };
}

export function resolveTikTokDraftTitle(content: TikTokDraftContent) {
  return toNullableTrimmed(content.editedTitle) || toNullableTrimmed(content.generatedTitle);
}

export function resolveTikTokDraftScript(content: TikTokDraftContent) {
  return toNullableTrimmed(content.editedScript) || toNullableTrimmed(content.generatedScript);
}

export function isTikTokDraftPublishable(content: TikTokDraftContent) {
  return Boolean(
    resolveTikTokDraftTitle(content) &&
      resolveTikTokDraftScript(content) &&
      toNullableTrimmed(content.confirmedPlaceLabel) &&
      Number.isFinite(content.confirmedPlaceLat) &&
      Number.isFinite(content.confirmedPlaceLng)
  );
}

export function serializeTikTokMetrics(
  extractedText: string | null | undefined,
  cleanedText: string | null | undefined,
  finalScript: string | null | undefined
) {
  return {
    extractedTextTokensEstimate: estimateTextTokenCount(extractedText),
    cleanedTextTokensEstimate: estimateTextTokenCount(cleanedText),
    finalScriptTokensEstimate: estimateTextTokenCount(finalScript),
  };
}
