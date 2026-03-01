const PLACEHOLDER_BY_CITY: Record<string, string> = {
  salem: "/images/salem/placeholder-01.png",
  boston: "/images/salem/placeholder-01.png",
  concord: "/images/salem/placeholder-01.png",
};

export function cityPlaceholderImage(city: string | null | undefined) {
  const key = (city || "").toLowerCase();
  return PLACEHOLDER_BY_CITY[key] || PLACEHOLDER_BY_CITY.salem;
}

type ResolveInput = {
  title: string;
  lat: number;
  lng: number;
  city: string;
};

export type PlaceImageResult = {
  imageUrl: string;
  placeId: string;
};

type PexelsPhoto = {
  id?: number;
  width?: number;
  height?: number;
  alt?: string;
  src?: {
    original?: string;
    large2x?: string;
    large?: string;
    medium?: string;
  };
};

type PexelsSearchResponse = {
  photos?: PexelsPhoto[];
};

function isRetryableStatus(code: number) {
  return code === 429 || (code >= 500 && code < 600);
}

async function fetchJsonWithRetry<T>(url: string, init: RequestInit, retries = 2): Promise<T> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= retries) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          attempt += 1;
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error("Unknown image request error");
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      attempt += 1;
    }
  }

  throw lastError || new Error("Image request failed");
}

const PEXELS_API_URL = "https://api.pexels.com/v1/search";
const PEXELS_RESULTS_PER_PAGE = 8;
const MIN_IMAGE_WIDTH = 1200;
const MIN_IMAGE_HEIGHT = 700;

function parsePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function pickPhotoUrl(photo: PexelsPhoto): string | null {
  const candidates = [photo.src?.large2x, photo.src?.large, photo.src?.original, photo.src?.medium];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function stableHash(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function collectEligiblePhotos(photos: PexelsPhoto[]) {
  const eligible: Array<{ imageUrl: string; photoId: number; alt: string }> = [];
  for (const photo of photos) {
    const photoId = parsePositiveNumber(photo.id);
    const width = parsePositiveNumber(photo.width);
    const height = parsePositiveNumber(photo.height);
    if (!photoId || !width || !height) continue;
    if (width < height) continue;
    if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) continue;

    const imageUrl = pickPhotoUrl(photo);
    if (!imageUrl) continue;

    eligible.push({ imageUrl, photoId, alt: typeof photo.alt === "string" ? photo.alt.trim() : "" });
  }

  return eligible;
}

function normalizeWords(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "tour",
  "landmark",
  "overview",
  "historic",
  "national",
  "site",
]);

function meaningfulTokens(value: string) {
  const normalized = normalizeWords(value);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !TITLE_STOP_WORDS.has(token));
}

function scorePhotoRelevance(
  photo: { imageUrl: string; photoId: number; alt: string },
  titleTokens: string[],
  cityTokens: string[],
  normalizedTitle: string
) {
  const haystack = normalizeWords(`${photo.alt} ${photo.imageUrl}`);
  if (!haystack) return 0;

  let score = 0;
  if (normalizedTitle && haystack.includes(normalizedTitle)) score += 10;
  for (const token of titleTokens) {
    if (haystack.includes(token)) score += 3;
  }
  for (const token of cityTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function selectBestPhoto(
  photos: Array<{ imageUrl: string; photoId: number; alt: string }>,
  seed: string,
  title: string,
  city: string
): { imageUrl: string; photoId: number } | null {
  if (!photos.length) return null;
  const titleTokens = meaningfulTokens(title);
  const cityTokens = meaningfulTokens(city).filter((token) => !titleTokens.includes(token));
  const normalizedTitle = normalizeWords(title);

  let bestScore = Number.NEGATIVE_INFINITY;
  let best: Array<{ imageUrl: string; photoId: number; alt: string }> = [];

  for (const photo of photos) {
    const score = scorePhotoRelevance(photo, titleTokens, cityTokens, normalizedTitle);
    if (score > bestScore) {
      bestScore = score;
      best = [photo];
      continue;
    }
    if (score === bestScore) best.push(photo);
  }

  const pool = best.length ? best : photos;
  const sortedPool = [...pool].sort((a, b) => a.photoId - b.photoId);
  const index = stableHash(seed) % sortedPool.length;
  const selected = sortedPool[index];
  return { imageUrl: selected.imageUrl, photoId: selected.photoId };
}

function uniqueQueries(...queries: string[]) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const query of queries) {
    const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(query.trim().replace(/\s+/g, " "));
  }
  return ordered;
}

async function fetchEligiblePhotos(query: string, apiKey: string) {
  const params = new URLSearchParams({
    query,
    per_page: String(PEXELS_RESULTS_PER_PAGE),
    page: "1",
    orientation: "landscape",
  });
  const url = `${PEXELS_API_URL}?${params.toString()}`;
  const data = await fetchJsonWithRetry<PexelsSearchResponse>(
    url,
    {
      cache: "no-store",
      headers: {
        Authorization: apiKey,
      },
    },
  );
  return collectEligiblePhotos(data.photos ?? []);
}

export async function resolvePlaceImage(input: ResolveInput): Promise<PlaceImageResult | null> {
  const apiKey = process.env.PEXELS_API_KEY?.trim();
  if (!apiKey) return null;

  const titleQuery = `${input.title}`;
  const titleOnlyQuery = `${input.title} landmark`;
  const titleCityQuery = `${input.title} ${input.city} landmark`;
  const queries = uniqueQueries(titleQuery, titleOnlyQuery, titleCityQuery);
  const seedBase = `${input.title}|${input.city}|${input.lat.toFixed(4)}|${input.lng.toFixed(4)}`;

  for (const query of queries) {
    const eligible = await fetchEligiblePhotos(query, apiKey);
    const selected = selectBestPhoto(eligible, `${seedBase}|${query.toLowerCase()}`, input.title, input.city);
    if (!selected) continue;
    return {
      imageUrl: selected.imageUrl,
      placeId: `pexels:${selected.photoId}`,
    };
  }

  return null;
}
