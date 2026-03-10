export type InstagramSourceKind = "reel" | "post";

export type InstagramImportDraftStatus =
  | "pending_import"
  | "importing"
  | "draft_ready"
  | "publishing"
  | "published"
  | "failed";

export type InstagramImportJobPhase = "import" | "publish";

export type InstagramImportJobStatus =
  | "queued"
  | "processing"
  | "draft_ready"
  | "published"
  | "failed";

export type InstagramImportEvent =
  | "import_started"
  | "import_succeeded"
  | "publish_started"
  | "publish_succeeded"
  | "job_failed";

export type InstagramNormalizedUrl = {
  normalizedUrl: string;
  sourceKind: InstagramSourceKind;
  shortcode: string;
};

export type InstagramPublicMetadata = {
  ownerTitle: string | null;
  ownerUserId: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
};

export type InstagramPlaceCandidate = {
  label: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
  googlePlaceId: string | null;
  formattedAddress: string | null;
};

export type InstagramImportJobResponse = {
  id: string;
  draftId: string;
  phase: InstagramImportJobPhase;
  status: InstagramImportJobStatus | "processing" | "queued" | "failed";
  progress: number;
  message: string;
  error: string | null;
  attempts: number;
  updatedAt: string;
};

export type InstagramDraftResponse = {
  id: string;
  status: InstagramImportDraftStatus;
  warning: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  source: {
    url: string;
    kind: InstagramSourceKind;
    shortcode: string;
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
  publish: {
    publishedJamId: string | null;
    publishedRouteId: string | null;
  };
  metrics: {
    extractedTextTokensEstimate: number | null;
    cleanedTextTokensEstimate: number | null;
    finalScriptTokensEstimate: number | null;
  };
  latestJob: InstagramImportJobResponse | null;
};

export type InstagramDraftContent = {
  editedTitle?: string | null;
  editedScript?: string | null;
  generatedTitle?: string | null;
  generatedScript?: string | null;
  confirmedPlaceLabel?: string | null;
  confirmedPlaceLat?: number | null;
  confirmedPlaceLng?: number | null;
};

function normalizeWhitespace(value: string | null | undefined) {
  return (value || "").replace(/\r\n/g, "\n").trim();
}

export function toNullableTrimmed(value: string | null | undefined) {
  const normalized = normalizeWhitespace(value);
  return normalized ? normalized : null;
}

export function estimateTextTokenCount(value: string | null | undefined) {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return null;
  return Math.max(1, Math.round(normalized.length / 4));
}

export function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripOuterQuotes(value: string) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("“") && trimmed.endsWith("”"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseMetaTags(html: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const metaByAttr = new Map<string, string>();

  for (const tag of tags) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
      attrs.set(match[1].toLowerCase(), decodeHtmlEntities(match[3]).trim());
    }
    const content = attrs.get("content");
    if (!content) continue;

    const name = attrs.get("name");
    const property = attrs.get("property");
    if (name) metaByAttr.set(`name:${name}`, content);
    if (property) metaByAttr.set(`property:${property}`, content);
  }

  return metaByAttr;
}

function extractMetaContent(
  metaByAttr: Map<string, string>,
  attr: "name" | "property",
  key: string
) {
  return toNullableTrimmed(metaByAttr.get(`${attr}:${key}`));
}

function formatInstagramHandle(handle: string | null | undefined) {
  const normalized = toNullableTrimmed(handle)?.replace(/^@+/, "");
  if (!normalized) return null;
  return `@${normalized}`;
}

function extractOwnerHandle(value: string | null) {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return null;
  const match = normalized.match(/(?:^|[^A-Za-z0-9._])@([A-Za-z0-9._]+)(?![A-Za-z0-9._])/);
  return formatInstagramHandle(match?.[1]);
}

function extractOwnerTitleFromDescription(description: string | null) {
  const normalized = toNullableTrimmed(description);
  if (!normalized) return null;
  const match = normalized.match(/-\s+([A-Za-z0-9._]+)\s+on\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}:/);
  return formatInstagramHandle(match?.[1]);
}

function extractOwnerTitleFromOgUrl(ogUrl: string | null) {
  const normalized = toNullableTrimmed(ogUrl);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length >= 3 && (segments[1] === "reel" || segments[1] === "p")) {
      return formatInstagramHandle(segments[0]);
    }
  } catch {
    return null;
  }
  return null;
}

function extractCaptionFromMeta(description: string | null, ogTitle: string | null) {
  const candidates = [description, ogTitle].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const colonQuoteIndex = candidate.indexOf(": \"");
    if (colonQuoteIndex >= 0) {
      return toNullableTrimmed(stripOuterQuotes(candidate.slice(colonQuoteIndex + 2).replace(/\.*\s*$/, "")));
    }
    const ogIndex = candidate.indexOf(" on Instagram: ");
    if (ogIndex >= 0) {
      return toNullableTrimmed(stripOuterQuotes(candidate.slice(ogIndex + " on Instagram: ".length).replace(/\.*\s*$/, "")));
    }
  }
  return toNullableTrimmed(description);
}

export function parseInstagramPublicMetadataFromHtml(html: string): InstagramPublicMetadata {
  const metaByAttr = parseMetaTags(html);
  const description = extractMetaContent(metaByAttr, "name", "description");
  const ogTitle = extractMetaContent(metaByAttr, "property", "og:title");
  const twitterTitle = extractMetaContent(metaByAttr, "name", "twitter:title");
  const ogUrl = extractMetaContent(metaByAttr, "property", "og:url");
  const ownerTitleRaw = ogTitle || twitterTitle;
  const ownerHandle =
    extractOwnerHandle(ownerTitleRaw) ||
    extractOwnerTitleFromDescription(description) ||
    extractOwnerTitleFromOgUrl(ogUrl);
  let ownerTitle = toNullableTrimmed(ownerTitleRaw);
  if (ownerTitle) {
    ownerTitle = ownerTitle
      .replace(/\s+on Instagram:.*$/i, "")
      .replace(/\s+•\s+Instagram.*$/i, "")
      .trim();
  }
  ownerTitle = ownerHandle || ownerTitle;

  return {
    ownerTitle,
    ownerUserId: extractMetaContent(metaByAttr, "property", "instapp:owner_user_id"),
    caption: extractCaptionFromMeta(description, ogTitle),
    thumbnailUrl:
      extractMetaContent(metaByAttr, "name", "twitter:image") ||
      extractMetaContent(metaByAttr, "property", "og:image"),
  };
}

export function normalizeInstagramUrl(rawUrl: string): InstagramNormalizedUrl | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!(host === "instagram.com" || host === "www.instagram.com" || host === "m.instagram.com")) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const root = segments[0]?.toLowerCase();
  const shortcode = (segments[1] || "").trim();
  if (!shortcode || !/^[A-Za-z0-9_-]+$/.test(shortcode)) return null;

  if (root === "p") {
    return {
      normalizedUrl: `https://www.instagram.com/p/${shortcode}/`,
      sourceKind: "post",
      shortcode,
    };
  }
  if (root === "reel" || root === "reels") {
    return {
      normalizedUrl: `https://www.instagram.com/reels/${shortcode}/`,
      sourceKind: "reel",
      shortcode,
    };
  }
  return null;
}

export function composeInstagramImportSourceText(
  caption: string | null | undefined,
  transcript: string | null | undefined
) {
  const normalizedCaption = toNullableTrimmed(caption);
  const normalizedTranscript = toNullableTrimmed(transcript);
  if (normalizedCaption && normalizedTranscript) {
    return `Transcript:\n${normalizedTranscript}\n\nCaption:\n${normalizedCaption}`;
  }
  return normalizedTranscript || normalizedCaption || "";
}

export function resolveInstagramDraftTitle(content: InstagramDraftContent) {
  return toNullableTrimmed(content.editedTitle) || toNullableTrimmed(content.generatedTitle);
}

export function resolveInstagramDraftScript(content: InstagramDraftContent) {
  return toNullableTrimmed(content.editedScript) || toNullableTrimmed(content.generatedScript);
}

export function isInstagramDraftPublishable(content: InstagramDraftContent) {
  return Boolean(
    resolveInstagramDraftTitle(content) &&
      resolveInstagramDraftScript(content) &&
      toNullableTrimmed(content.confirmedPlaceLabel) &&
      Number.isFinite(content.confirmedPlaceLat) &&
      Number.isFinite(content.confirmedPlaceLng)
  );
}

export function nextInstagramDraftStatus(
  status: InstagramImportDraftStatus,
  event: InstagramImportEvent
): InstagramImportDraftStatus {
  switch (event) {
    case "import_started":
      return status === "pending_import" ? "importing" : status;
    case "import_succeeded":
      return status === "pending_import" || status === "importing" ? "draft_ready" : status;
    case "publish_started":
      return status === "draft_ready" ? "publishing" : status;
    case "publish_succeeded":
      return status === "publishing" ? "published" : status;
    case "job_failed":
      return status === "published" ? "published" : "failed";
    default:
      return status;
  }
}

export function successJobStatusForPhase(phase: InstagramImportJobPhase): InstagramImportJobStatus {
  return phase === "publish" ? "published" : "draft_ready";
}
