export type InstagramSourceKind = "reel" | "post";

export type InstagramImportDraftStatus =
  | "pending_import"
  | "importing"
  | "draft_ready"
  | "publishing"
  | "published"
  | "failed";

export type InstagramImportJobPhase = "import" | "publish" | "publish_collection";

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

export type InstagramRouteAttribution = {
  storyBy: string | null;
  storyByUrl: string | null;
  storyByAvatarUrl: string | null;
  storyBySource: "instagram" | null;
  isCollective: boolean;
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
  draftIds: string[] | null;
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

export type InstagramScriptGenerationSources = {
  caption?: string | null;
  transcript?: string | null;
  cleanedText?: string | null;
};

export type InstagramCollectionDraftStatus =
  | "importing"
  | "ready"
  | "needs_location"
  | "published"
  | "failed";

export type InstagramCollectionDraftSnapshot = {
  status: InstagramImportDraftStatus;
  location: {
    publishReady: boolean;
  };
};

export const INSTAGRAM_COLLECTION_MAX_STOPS = 10;
export const INSTAGRAM_IMPORT_MAX_SPLIT_STOPS = 5;

export type InstagramTourStopConversion = {
  title: string;
  script: string;
  placeQuery: string;
  cityHint: string | null;
  countryHint: string | null;
  confidence: number;
};

export function instagramRouteStopIdForDraft(draftId: string) {
  return `ig-${draftId.slice(0, 12)}`;
}

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

export function formatInstagramHandle(handle: string | null | undefined) {
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

export function buildInstagramProfileUrl(ownerTitle: string | null | undefined) {
  const normalizedHandle =
    extractOwnerHandle(ownerTitle ?? null) || formatInstagramHandle(ownerTitle);
  if (!normalizedHandle) return null;
  return `https://www.instagram.com/${encodeURIComponent(normalizedHandle.slice(1))}/`;
}

export function extractInstagramUsernameFromProfileUrl(profileUrl: string | null | undefined) {
  const normalized = toNullableTrimmed(profileUrl);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const username = segments[0]?.trim();
    if (!username || username.startsWith("accounts")) return null;
    return username;
  } catch {
    return null;
  }
}

export function proxyInstagramImageUrl(value: string | null | undefined) {
  const normalized = toNullableTrimmed(value);
  if (!normalized) return normalized;
  if (normalized.startsWith("/")) return normalized;

  try {
    const parsed = new URL(normalized);
    if (!parsed.protocol.startsWith("http")) return normalized;
    if (!parsed.hostname.toLowerCase().endsWith("cdninstagram.com")) return normalized;
    return `/api/instagram-image?url=${encodeURIComponent(normalized)}`;
  } catch {
    return normalized;
  }
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

export function parseInstagramProfileImageUrlFromHtml(html: string) {
  const metaByAttr = parseMetaTags(html);
  const metaImage =
    extractMetaContent(metaByAttr, "name", "twitter:image") ||
    extractMetaContent(metaByAttr, "property", "og:image");
  if (metaImage) return metaImage;

  const scriptPatterns = [
    /"profile_pic_url_hd":"([^"]+)"/,
    /"profile_pic_url":"([^"]+)"/,
    /"hd_profile_pic_url_info"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/,
    /"profilePictureUrl"\s*:\s*"([^"]+)"/,
  ];

  for (const pattern of scriptPatterns) {
    const match = html.match(pattern);
    const candidate = toNullableTrimmed(match?.[1]?.replaceAll("\\u0026", "&").replaceAll("\\/", "/"));
    if (candidate) return candidate;
  }

  return null;
}

export function deriveInstagramRouteAttribution(
  creators: Array<{
    ownerTitle?: string | null;
    profileImageUrl?: string | null;
  }>
): InstagramRouteAttribution {
  const uniqueCreators = new Map<
    string,
    {
      label: string;
      url: string | null;
      avatarUrl: string | null;
    }
  >();

  for (const creator of creators) {
    const label =
      extractOwnerHandle(creator.ownerTitle ?? null) ||
      formatInstagramHandle(creator.ownerTitle) ||
      toNullableTrimmed(creator.ownerTitle);
    if (!label) continue;
    const url = buildInstagramProfileUrl(label);
    const key = url || label.toLowerCase();
    if (uniqueCreators.has(key)) continue;
    uniqueCreators.set(key, {
      label,
      url,
      avatarUrl: toNullableTrimmed(creator.profileImageUrl),
    });
  }

  const resolvedCreators = Array.from(uniqueCreators.values());
  if (resolvedCreators.length === 0) {
    return {
      storyBy: null,
      storyByUrl: null,
      storyByAvatarUrl: null,
      storyBySource: null,
      isCollective: false,
    };
  }

  if (resolvedCreators.length > 1) {
    return {
      storyBy: "Instagram creators",
      storyByUrl: null,
      storyByAvatarUrl: null,
      storyBySource: "instagram",
      isCollective: true,
    };
  }

  const [creator] = resolvedCreators;
  return {
    storyBy: creator.label,
    storyByUrl: creator.url,
    storyByAvatarUrl: creator.avatarUrl,
    storyBySource: "instagram",
    isCollective: false,
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

export function buildInstagramScriptGenerationSourceText(
  sources: InstagramScriptGenerationSources
) {
  const sections: string[] = [];
  const normalizedTranscript = toNullableTrimmed(sources.transcript);
  const normalizedCaption = toNullableTrimmed(sources.caption);
  const normalizedCleanedText = toNullableTrimmed(sources.cleanedText);

  if (normalizedTranscript) {
    sections.push(`Transcript:\n${normalizedTranscript}`);
  }
  if (normalizedCaption) {
    sections.push(`Caption:\n${normalizedCaption}`);
  }
  if (normalizedCleanedText) {
    sections.push(`Cleaned notes:\n${normalizedCleanedText}`);
  }

  return sections.join("\n\n");
}

function extractJsonValue(raw: string) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed;
  }

  const firstObjectBrace = trimmed.indexOf("{");
  const lastObjectBrace = trimmed.lastIndexOf("}");
  const firstArrayBrace = trimmed.indexOf("[");
  const lastArrayBrace = trimmed.lastIndexOf("]");

  if (
    firstArrayBrace >= 0 &&
    lastArrayBrace > firstArrayBrace &&
    (firstObjectBrace < 0 || firstArrayBrace < firstObjectBrace)
  ) {
    return trimmed.slice(firstArrayBrace, lastArrayBrace + 1);
  }

  if (firstObjectBrace >= 0 && lastObjectBrace > firstObjectBrace) {
    return trimmed.slice(firstObjectBrace, lastObjectBrace + 1);
  }

  throw new Error("JSON response was not found in model output");
}

function normalizeInstagramTourStopConversion(
  value: unknown
): InstagramTourStopConversion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const title = toNullableTrimmed(typeof candidate.title === "string" ? candidate.title : null);
  const script = toNullableTrimmed(typeof candidate.script === "string" ? candidate.script : null);
  const placeQuery = toNullableTrimmed(
    typeof candidate.placeQuery === "string" ? candidate.placeQuery : null
  );
  if (!title || !script || !placeQuery) return null;

  const confidence = Number(candidate.confidence);
  return {
    title,
    script,
    placeQuery,
    cityHint: toNullableTrimmed(typeof candidate.cityHint === "string" ? candidate.cityHint : null),
    countryHint: toNullableTrimmed(
      typeof candidate.countryHint === "string" ? candidate.countryHint : null
    ),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.45,
  };
}

export function parseInstagramTourStopConversions(
  raw: string,
  maxStops = INSTAGRAM_IMPORT_MAX_SPLIT_STOPS
) {
  const parsed = JSON.parse(extractJsonValue(raw)) as
    | unknown[]
    | { stops?: unknown[] }
    | Record<string, unknown>;

  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { stops?: unknown[] }).stops)
      ? (parsed as { stops: unknown[] }).stops
      : [parsed];

  const normalized = candidates
    .map((candidate) => normalizeInstagramTourStopConversion(candidate))
    .filter((candidate): candidate is InstagramTourStopConversion => Boolean(candidate))
    .slice(0, Math.max(1, Math.floor(maxStops) || INSTAGRAM_IMPORT_MAX_SPLIT_STOPS));

  if (normalized.length === 0) {
    throw new Error("Tour stop conversion returned incomplete JSON");
  }

  if (candidates.length > 0 && normalized.length !== Math.min(candidates.length, maxStops)) {
    throw new Error("Tour stop conversion returned incomplete JSON");
  }

  return normalized;
}

export function normalizeInstagramCollectionDraftIds(
  draftIds: Array<string | null | undefined>,
  maxStops = INSTAGRAM_COLLECTION_MAX_STOPS
) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of draftIds) {
    const draftId = toNullableTrimmed(value);
    if (!draftId || seen.has(draftId)) continue;
    seen.add(draftId);
    normalized.push(draftId);
    if (normalized.length >= maxStops) break;
  }

  return normalized;
}

export function normalizeInstagramImportJobDraftIds(
  phase: InstagramImportJobPhase,
  draftId: string | null | undefined,
  draftIds: Array<string | null | undefined> | null | undefined
) {
  const maxStops =
    phase === "publish_collection"
      ? INSTAGRAM_COLLECTION_MAX_STOPS
      : phase === "import"
        ? INSTAGRAM_IMPORT_MAX_SPLIT_STOPS
        : 1;
  return normalizeInstagramCollectionDraftIds(draftIds ?? [draftId], maxStops);
}

export function addInstagramCollectionDraftId(
  draftIds: Array<string | null | undefined>,
  draftId: string | null | undefined,
  maxStops = INSTAGRAM_COLLECTION_MAX_STOPS
) {
  const normalizedDraftId = toNullableTrimmed(draftId);
  const normalized = normalizeInstagramCollectionDraftIds(draftIds, maxStops);
  if (!normalizedDraftId || normalized.includes(normalizedDraftId) || normalized.length >= maxStops) {
    return normalized;
  }
  return [...normalized, normalizedDraftId];
}

export function removeInstagramCollectionDraftId(
  draftIds: Array<string | null | undefined>,
  draftId: string | null | undefined
) {
  const normalizedDraftId = toNullableTrimmed(draftId);
  if (!normalizedDraftId) return normalizeInstagramCollectionDraftIds(draftIds);
  return normalizeInstagramCollectionDraftIds(draftIds).filter((value) => value !== normalizedDraftId);
}

export function deriveInstagramCollectionRouteTitle(
  routeTitle: string | null | undefined,
  draftCount: number,
  singleStopTitle: string | null | undefined
) {
  const normalizedRouteTitle = toNullableTrimmed(routeTitle);
  if (normalizedRouteTitle) return normalizedRouteTitle;
  if (draftCount <= 1) return toNullableTrimmed(singleStopTitle);
  return `Instagram Route (${draftCount} stops)`;
}

export function getInstagramCollectionDraftStatus(
  draft: InstagramCollectionDraftSnapshot
): InstagramCollectionDraftStatus {
  if (draft.status === "failed") return "failed";
  if (draft.status === "published") return "published";
  if (draft.status === "draft_ready" && draft.location.publishReady) return "ready";
  if (draft.status === "draft_ready") return "needs_location";
  return "importing";
}

export function canMasterPublishInstagramDrafts(
  drafts: Array<InstagramCollectionDraftSnapshot | null | undefined>,
  maxStops = INSTAGRAM_COLLECTION_MAX_STOPS
) {
  if (drafts.length === 0 || drafts.length > maxStops) return false;
  return drafts.every((draft) => {
    if (!draft) return false;
    const status = getInstagramCollectionDraftStatus(draft);
    return status === "ready" || status === "published";
  });
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
  return phase === "import" ? "draft_ready" : "published";
}
